// Verify keys_highway_3d's Auto-mode predicate yields vocal arrangements
// while continuing to claim other notated arrangements.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCREEN_JS = path.join(
    __dirname, '..', '..', 'plugins', 'keys_highway_3d', 'screen.js',
);

function loadMatchesArrangement() {
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(SCREEN_JS, 'utf8'), sandbox);
    return sandbox.window.slopsmithViz_keys_highway_3d.matchesArrangement;
}

test('yields notated vocal arrangements to a vocals visualization', () => {
    const matchesArrangement = loadMatchesArrangement();

    for (const arrangement of [
        'Vocals',
        'Lead Vocal',
        'Backing Vocals',
        'Vox',
        'Sing',
        'Singing',
        'Singer',
    ]) {
        assert.equal(
            matchesArrangement({ has_notation: true, arrangement }),
            false,
            `must yield '${arrangement}'`,
        );
    }
});

test('still claims ordinary notated arrangements', () => {
    const matchesArrangement = loadMatchesArrangement();

    for (const arrangement of ['Keys', 'Piano', 'Synth', 'Combo', '']) {
        assert.equal(
            matchesArrangement({ has_notation: true, arrangement }),
            true,
            `must claim '${arrangement || '(unnamed)'}'`,
        );
    }
});

test('requires notation even when the arrangement is not vocals', () => {
    const matchesArrangement = loadMatchesArrangement();

    assert.equal(matchesArrangement({ arrangement: 'Keys' }), false);
    assert.equal(matchesArrangement({ has_notation: false, arrangement: 'Piano' }), false);
    assert.equal(matchesArrangement(null), false);
});

test('does not over-match word-bounded vox and sing aliases', () => {
    const matchesArrangement = loadMatchesArrangement();

    for (const arrangement of ['Voxel Synth', 'Single Coil Lead']) {
        assert.equal(
            matchesArrangement({ has_notation: true, arrangement }),
            true,
            `must not treat '${arrangement}' as vocals`,
        );
    }
});
