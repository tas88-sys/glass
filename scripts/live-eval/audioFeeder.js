'use strict';

// Feeds the two STT sessions the way the Listen window does: one 100 ms chunk
// of 24 kHz mono 16-bit PCM per channel per tick, base64, 'audio/pcm;rate=24000'
// (listenCapture.js AUDIO_CHUNK_DURATION). Both channels run all the time, as an
// open mic and system audio would: a queued clip plays in real time and
// low-level noise fills the gaps, so the provider's endpointing, the 2 s turn
// debounce (sttService COMPLETION_DEBOUNCE_MS) and Live Answer's 800 ms
// debounce see what they see in a real call.

const { RATE } = require('./tts');

const CHUNK_MS = 100;
const CHUNK_BYTES = (RATE * CHUNK_MS / 1000) * 2;
const MIME = 'audio/pcm;rate=24000';

function noiseChunk() {
    const b = Buffer.alloc(CHUNK_BYTES);
    for (let i = 0; i < CHUNK_BYTES; i += 2) b.writeInt16LE(Math.round((Math.random() - 0.5) * 24), i);
    return b;
}

/**
 * @param {object} o
 * @param {(b64: string, mime: string) => Promise<any>} o.sendThem - sttService.sendSystemAudioContent
 * @param {(b64: string, mime: string) => Promise<any>} o.sendMe - sttService.sendMicAudioContent
 * @param {(line: string) => void} [o.log]
 * @param {number} [o.speed=1] - >1 sends faster than real time (less realistic endpointing)
 */
function createFeeder({ sendThem, sendMe, log = () => {}, speed = 1 }) {
    const queues = { them: [], me: [] };
    const waiters = { them: [], me: [] };
    let timer = null;
    let started = 0;
    let ticks = 0;
    let errors = 0;

    function enqueue(channel, pcm) {
        const q = queues[channel];
        for (let off = 0; off < pcm.length; off += CHUNK_BYTES) {
            let c = pcm.subarray(off, off + CHUNK_BYTES);
            if (c.length < CHUNK_BYTES) c = Buffer.concat([c, Buffer.alloc(CHUNK_BYTES - c.length)]);
            q.push(c);
        }
    }

    async function send(channel, chunk) {
        try {
            await (channel === 'them' ? sendThem : sendMe)(chunk.toString('base64'), MIME);
        } catch (err) {
            errors++;
            if (errors <= 3) log(`[feeder] ${channel} send failed: ${err.message}`);
        }
    }

    function tick() {
        // Catch up to wall time (timers drift); never more than 5 chunks at once.
        const due = Math.floor(((Date.now() - started) * speed) / CHUNK_MS);
        let n = 0;
        while (ticks < due && n < 5) {
            ticks++;
            n++;
            for (const ch of ['them', 'me']) {
                const q = queues[ch];
                const chunk = q.length ? q.shift() : noiseChunk();
                send(ch, chunk);
                if (!q.length && waiters[ch].length) {
                    const w = waiters[ch].splice(0);
                    for (const resolve of w) resolve(Date.now());
                }
            }
        }
    }

    return {
        start() {
            if (timer) return;
            started = Date.now();
            ticks = 0;
            timer = setInterval(tick, CHUNK_MS / 2);
        },
        stop() {
            if (timer) clearInterval(timer);
            timer = null;
            for (const ch of ['them', 'me']) {
                queues[ch] = [];
                for (const resolve of waiters[ch].splice(0)) resolve(Date.now());
            }
        },
        /**
         * Queue a clip on one channel. Resolves with the wall time its last chunk was sent.
         * @param {'them'|'me'} channel
         * @param {Buffer} pcm
         */
        play(channel, pcm) {
            enqueue(channel, pcm);
            return new Promise(resolve => waiters[channel].push(resolve));
        },
        get errors() {
            return errors;
        },
    };
}

module.exports = { createFeeder, CHUNK_MS, CHUNK_BYTES };
