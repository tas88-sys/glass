/**
 * golden.test.js
 *
 * Everything outside System Design · Live is sent byte for byte as before item
 * 18.11 (rule 8): the system prompts of every profile, the Ask messages of the
 * other modes, and the Live Answer lane's messages and stream options for a
 * fixed sequence of turns. golden/golden.json was written before the change
 * (golden/capture.js --write).
 *
 * Run: node --test src/features/common/prompts/__tests__/golden.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const golden = require('./golden/golden.json');
const { profiles, askMessages, laneMessages } = require('./golden/capture');
const { SD_LIVE_GOLDEN_EDITS } = require('./golden/sdLiveEdits');

describe('golden: what is sent outside System Design · Live (item 18.11, rule 8)', () => {
    const now = profiles();

    it('has the same profiles as before, plus the probe profile', () => {
        const added = Object.keys(now).filter(n => !(n in golden.profiles));
        assert.deepEqual(added, ['pickle_glass_system_design_probe']);
        for (const name of Object.keys(golden.profiles)) assert.ok(name in now, `${name} is gone`);
    });

    for (const name of Object.keys(golden.profiles)) {
        if (name === 'pickle_glass_system_design_live') continue;
        it(`profile ${name} is unchanged, byte for byte`, () => {
            assert.equal(now[name].noSearch, golden.profiles[name].noSearch);
            assert.equal(now[name].search, golden.profiles[name].search);
        });
    }

    it('System Design · Live changes only by its three edits (route 0, the language line and the diagram rule)', () => {
        for (const variant of ['noSearch', 'search']) {
            let expected = golden.profiles.pickle_glass_system_design_live[variant];
            for (const { from, to } of SD_LIVE_GOLDEN_EDITS) {
                assert.ok(expected.includes(from), `the golden prompt holds ${JSON.stringify(from.slice(0, 40))}`);
                expected = expected.replace(from, to);
            }
            assert.equal(now.pickle_glass_system_design_live[variant], expected);
        }
    });

    it('the Ask messages of default, code, debug and system_design are unchanged', () => {
        assert.deepEqual(askMessages(), golden.ask);
    });

    it('the Live Answer lane sends the same messages and options for the same turns', async () => {
        const calls = await laneMessages();
        assert.deepEqual(calls, golden.lane);
    });
});
