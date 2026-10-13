'use strict';

// Text → 24 kHz mono 16-bit PCM, the format the app's STT sessions take
// (listenCapture.js sends audio/pcm;rate=24000; deepgram.js opens linear16 at
// 24000). Gemini TTS first (@google/genai; it returns WAV or raw L16); the
// Windows SAPI voices (en-US only) when Gemini TTS is unavailable and the text
// is English. Every clip is cached by (text, voice, language) under the cache
// dir, outside the repo: the career-route questions become audio too, and
// that audio must never reach this public repo.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const RATE = 24000;
const DEFAULT_MODELS = ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts', 'gemini-2.5-flash-preview-tts'];
// Gemini prebuilt voices: one for the interviewer, one for the candidate.
const VOICES = { them: 'Charon', me: 'Kore' };
const SAPI_VOICES = { them: 'Microsoft David Desktop', me: 'Microsoft Zira Desktop' };

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Parse a RIFF/WAVE buffer → { rate, channels, bits, pcm }. */
function parseWav(buf) {
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV');
    let off = 12;
    let fmt = null;
    while (off + 8 <= buf.length) {
        const id = buf.toString('ascii', off, off + 4);
        const size = buf.readUInt32LE(off + 4);
        if (id === 'fmt ') {
            fmt = { format: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
        } else if (id === 'data') {
            if (!fmt) throw new Error('WAV data before fmt');
            if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`WAV not 16-bit PCM (format ${fmt.format}, ${fmt.bits} bits)`);
            const end = Math.min(buf.length, off + 8 + size);
            return { rate: fmt.rate, channels: fmt.channels, pcm: buf.subarray(off + 8, end) };
        }
        off += 8 + size + (size % 2);
    }
    throw new Error('WAV without data');
}

/** 16-bit PCM of any rate and channel count → mono at RATE (linear interpolation). */
function toMono24k({ rate, channels, pcm }) {
    const frames = Math.floor(pcm.length / (2 * channels));
    const mono = new Float64Array(frames);
    for (let i = 0; i < frames; i++) {
        let s = 0;
        for (let c = 0; c < channels; c++) s += pcm.readInt16LE((i * channels + c) * 2);
        mono[i] = s / channels;
    }
    if (rate === RATE) {
        const out = Buffer.alloc(frames * 2);
        for (let i = 0; i < frames; i++) out.writeInt16LE(Math.round(mono[i]), i * 2);
        return out;
    }
    const outFrames = Math.floor((frames * RATE) / rate);
    const out = Buffer.alloc(outFrames * 2);
    for (let i = 0; i < outFrames; i++) {
        const x = (i * rate) / RATE;
        const i0 = Math.floor(x);
        const i1 = Math.min(frames - 1, i0 + 1);
        const v = mono[i0] + (mono[i1] - mono[i0]) * (x - i0);
        out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2);
    }
    return out;
}

/** inlineData from Gemini TTS → PCM at RATE. */
function decodeGeminiAudio(mimeType, data) {
    const buf = Buffer.from(data, 'base64');
    if (/wav/i.test(mimeType || '') || buf.toString('ascii', 0, 4) === 'RIFF') return toMono24k(parseWav(buf));
    const rate = Number((/rate=(\d+)/i.exec(mimeType || '') || [])[1]) || RATE;
    return toMono24k({ rate, channels: 1, pcm: buf });
}

function createTts({ geminiKey, cacheDir, models = DEFAULT_MODELS, log = () => {} }) {
    let ai = null;
    let workingModel = null;
    const deadModels = new Set();
    fs.mkdirSync(cacheDir, { recursive: true });

    function cachePath(text, speaker, lang) {
        const h = crypto.createHash('sha256').update(`${speaker}\0${lang}\0${text}`).digest('hex').slice(0, 32);
        return path.join(cacheDir, `${h}.pcm`);
    }

    async function viaGemini(text, speaker) {
        if (!geminiKey) throw new Error('no Gemini key');
        if (!ai) {
            const { GoogleGenAI } = require('@google/genai');
            ai = new GoogleGenAI({ apiKey: geminiKey });
        }
        const order = workingModel ? [workingModel, ...models.filter(m => m !== workingModel)] : models;
        let lastErr = null;
        for (const model of order) {
            if (deadModels.has(model)) continue;
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    const r = await ai.models.generateContent({
                        model,
                        contents: [{ parts: [{ text }] }],
                        config: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICES[speaker] || VOICES.them } } } },
                    });
                    const part = r.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data);
                    if (!part) throw new Error('no audio in the response');
                    workingModel = model;
                    return { pcm: decodeGeminiAudio(part.inlineData.mimeType, part.inlineData.data), engine: `gemini:${model}` };
                } catch (err) {
                    lastErr = err;
                    const status = err.status || err.code;
                    // A missing model, or a spent quota (the free tier's daily TTS cap): no retry this run.
                    if (status === 404 || status === 400 || (status === 429 && /PerDay/i.test(String(err.message)))) {
                        deadModels.add(model);
                        log(`[tts] ${model} unavailable for this run (${status})`);
                        break;
                    }
                    if (status === 429 || status === 500 || status === 503) {
                        const wait = 5000 * (attempt + 1);
                        log(`[tts] ${model} ${status}, retrying in ${wait / 1000}s`);
                        await sleep(wait);
                        continue;
                    }
                    break;
                }
            }
        }
        throw lastErr || new Error('Gemini TTS unavailable');
    }

    function viaSapi(text, speaker, lang) {
        if (process.platform !== 'win32') return Promise.reject(new Error('SAPI is Windows only'));
        if (!/^en/i.test(lang)) return Promise.reject(new Error(`no SAPI voice for ${lang}`));
        const tmp = path.join(cacheDir, `sapi-${process.pid}-${Date.now()}.wav`);
        const txt = `${tmp}.txt`;
        fs.writeFileSync(txt, text, 'utf8');
        const voice = SAPI_VOICES[speaker] || SAPI_VOICES.them;
        const ps = [
            'Add-Type -AssemblyName System.Speech',
            '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
            `try { $s.SelectVoice('${voice}') } catch {}`,
            `$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(${RATE}, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)`,
            `$s.SetOutputToWaveFile('${tmp}', $f)`,
            `$s.Speak([IO.File]::ReadAllText('${txt}'))`,
            '$s.Dispose()',
        ].join('; ');
        return new Promise((resolve, reject) => {
            execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 60_000 }, err => {
                try {
                    if (err) return reject(err);
                    resolve({ pcm: toMono24k(parseWav(fs.readFileSync(tmp))), engine: 'sapi' });
                } catch (e) {
                    reject(e);
                } finally {
                    fs.rmSync(tmp, { force: true });
                    fs.rmSync(txt, { force: true });
                }
            });
        });
    }

    /**
     * @param {string} text
     * @param {'them'|'me'} speaker
     * @param {'pt-BR'|'en-US'} lang
     * @returns {Promise<{ pcm: Buffer, engine: string, cached: boolean, seconds: number }>}
     */
    async function speak(text, speaker, lang) {
        const file = cachePath(text, speaker, lang);
        if (fs.existsSync(file)) {
            const pcm = fs.readFileSync(file);
            return { pcm, engine: 'cache', cached: true, seconds: pcm.length / (RATE * 2) };
        }
        let out;
        try {
            out = await viaGemini(text, speaker);
        } catch (gemErr) {
            try {
                out = await viaSapi(text, speaker, lang);
                log(`[tts] Gemini TTS failed (${gemErr.status || ''} ${String(gemErr.message).slice(0, 80)}); used SAPI`);
            } catch (sapiErr) {
                throw new Error(`no TTS: Gemini (${String(gemErr.message).slice(0, 120)}); SAPI (${sapiErr.message})`);
            }
        }
        fs.writeFileSync(file, out.pcm);
        return { ...out, cached: false, seconds: out.pcm.length / (RATE * 2) };
    }

    return { speak };
}

module.exports = { createTts, parseWav, toMono24k, decodeGeminiAudio, RATE };
