/**
 * deepgramRequest.test.js
 *
 * The live-transcription query carries the language the app asks for.
 * Run: node --test src/features/common/ai/providers/__tests__/deepgramRequest.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildListenQuery } = require('../deepgram');

describe('deepgram buildListenQuery', () => {
    it('sends the language it is given', () => {
        assert.equal(buildListenQuery({ language: 'pt-BR' }).get('language'), 'pt-BR');
        assert.equal(buildListenQuery({ language: 'en-US' }).get('language'), 'en-US');
    });

    it('keeps the audio format and model', () => {
        const qs = buildListenQuery({ language: 'pt-BR', sampleRate: 16000 });
        assert.equal(qs.get('model'), 'nova-3');
        assert.equal(qs.get('encoding'), 'linear16');
        assert.equal(qs.get('sample_rate'), '16000');
        assert.equal(qs.get('interim_results'), 'true');
    });

    it('defaults the sample rate to 24000', () => {
        assert.equal(buildListenQuery({ language: 'pt-BR' }).get('sample_rate'), '24000');
    });

    it('sends each keyterm as its own parameter, skipping blanks', () => {
        const qs = buildListenQuery({ language: 'pt-BR', keyterms: ['LINQ', ' Spring Boot ', '', null, 'gRPC'] });
        assert.deepEqual(qs.getAll('keyterm'), ['LINQ', 'Spring Boot', 'gRPC']);
        assert.match(qs.toString(), /keyterm=LINQ&keyterm=Spring\+Boot&keyterm=gRPC/);
    });

    it('sends no keyterm without a list', () => {
        assert.deepEqual(buildListenQuery({ language: 'en-US' }).getAll('keyterm'), []);
        assert.deepEqual(buildListenQuery({ language: 'en-US', keyterms: 'LINQ' }).getAll('keyterm'), []);
    });
});
