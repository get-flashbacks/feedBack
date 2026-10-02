// feedBack#136 — the per-highway difficulty-override seam.
//
// The createHighway closure is too heavy for a Node sandbox, so the pure
// helpers are extracted and run directly (the same approach as
// highway_phrase_tiers.test.js / highway_chart_transform.test.js) and the
// wiring is pinned by source inspection.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function extractFunction(src, name) {
    const start = src.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} present`);
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') {
            depth -= 1;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    assert.fail(`${name} body is balanced`);
}

// Shorthand object-method form (`setDifficultyOverride(override) {`), not a
// `function` declaration — same brace-balancing walk, different marker.
function extractMethod(src, signature) {
    const start = src.indexOf(`${signature} {`);
    assert.ok(start >= 0, `${signature} present`);
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') {
            depth -= 1;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    assert.fail(`${signature} body is balanced`);
}

// A fixed, repo-relative file resolved by the module system from a literal
// specifier; no input reaches this path. highway.js is only read, not loaded.
const src = fs.readFileSync(require.resolve('../../static/highway.js'), 'utf8'); // nosemgrep

const sandbox = { hwState: { _mastery: 1, _difficultyOverride: null, chartTime: 0 } };
vm.runInNewContext([
    extractFunction(src, 'phraseLevelTiers'),
    extractFunction(src, 'phraseLevelIndexForMastery'),
    extractFunction(src, 'phraseTopDifficulty'),
    extractFunction(src, '_effectiveMasteryAt'),
].join('\n'), sandbox);
const { phraseLevelIndexForMastery, _effectiveMasteryAt } = sandbox;

function withOverride(override) {
    sandbox.hwState._mastery = 1;
    sandbox.hwState._difficultyOverride = override;
}

test('without an override the effective difficulty is always the song-wide slider', () => {
    withOverride(null);
    for (const time of [0, 12.5, 24, 1e6, NaN, undefined, null]) {
        assert.equal(_effectiveMasteryAt(time), 1, `time ${time}`);
    }
    sandbox.hwState._mastery = 0.4;
    assert.equal(_effectiveMasteryAt(12.5), 0.4);
});

test('the override window is half-open: [start_time, end_time)', () => {
    withOverride({ startTime: 12.5, endTime: 24, fraction: 0.4 });
    assert.equal(_effectiveMasteryAt(11.9), 1, 'before the window the slider applies');
    assert.equal(_effectiveMasteryAt(12.5), 0.4, 'start_time is inside the window');
    assert.equal(_effectiveMasteryAt(23.999), 0.4, 'the last moment inside the window');
    assert.equal(_effectiveMasteryAt(24), 1, 'end_time is outside the window');
    assert.equal(_effectiveMasteryAt(40), 1, 'after the window the slider applies');
});

test('a non-finite query falls back to the slider rather than the override', () => {
    withOverride({ startTime: 12.5, endTime: 24, fraction: 0.4 });
    // The render loop's pre-song frame, and a caller that passed nothing.
    assert.equal(_effectiveMasteryAt(NaN), 1);
    assert.equal(_effectiveMasteryAt(undefined), 1);
});

test('an override picks phrase levels without touching the song-wide mastery value', () => {
    // The whole point of the seam: hwState._mastery keeps reporting the
    // slider (so Difficulty Ladder's adaptive controller and the slider UI
    // stay consistent) while phrases inside the window render at the
    // override difficulty.
    sandbox.hwState._mastery = 0.9;
    sandbox.hwState._difficultyOverride = { startTime: 12.5, endTime: 24, fraction: 0.4 };
    const levels = [{ difficulty: 0 }, { difficulty: 1 }, { difficulty: 2 }, { difficulty: 3 }];

    assert.equal(phraseLevelIndexForMastery(levels, 3, _effectiveMasteryAt(0)), 3,
        'a phrase before the window plays at the slider difficulty');
    assert.equal(phraseLevelIndexForMastery(levels, 3, _effectiveMasteryAt(13)), 1,
        'a phrase inside the window plays at the override difficulty');
    assert.equal(phraseLevelIndexForMastery(levels, 3, _effectiveMasteryAt(30)), 3,
        'a phrase after the window plays at the slider difficulty');

    assert.equal(sandbox.hwState._mastery, 0.9, 'the song-wide mastery value is never rewritten');
});

// --- Source-level wiring -------------------------------------------------

test('the public API exposes the override getters/setter', () => {
    assert.match(src, /setDifficultyOverride\(override\)\s*\{/);
    assert.match(src, /getDifficultyOverride\(\)\s*\{/);
    assert.match(src, /getEffectiveMastery\(time\)\s*\{\s*return _effectiveMasteryAt\(time === undefined \? hwState\.chartTime : time\);\s*\}/,
        'getEffectiveMastery() with no argument reads the live playback time');
});

test('getMastery still reports hwState._mastery, not the effective value', () => {
    // Regression guard: folding the override into getMastery() would make
    // an adaptive consumer believe the slider itself moved.
    assert.match(src, /getMastery\(\)\s*\{\s*return hwState\._mastery;\s*\}/);
});

test('no override code path ever writes hwState._mastery', () => {
    // Stronger than asserting getMastery() reads one field: the override
    // helpers must not reach the slider at all, so the adaptive
    // controller can never observe a slider move it did not cause.
    const bodies = [
        extractFunction(src, '_effectiveMasteryAt'),
        extractFunction(src, '_setOverrideState'),
        extractMethod(src, 'setDifficultyOverride(override)'),
        extractMethod(src, 'getDifficultyOverride()'),
        extractMethod(src, 'getEffectiveMastery(time)'),
    ];
    for (const body of bodies) {
        assert.doesNotMatch(body, /hwState\._mastery\s*=(?!=)/,
            `override code must not assign the slider:\n${body.slice(0, 80)}`);
    }
});

test('setDifficultyOverride refuses garbage instead of blanking the chart', () => {
    const fn = extractMethod(src, 'setDifficultyOverride(override)');
    assert.match(fn, /if \(typeof override !== 'object'\) return;/,
        'a non-object leaves the previous override in place');
    assert.match(fn, /if \(!Number\.isFinite\(startTime\) \|\| !Number\.isFinite\(endTime\)\) return;/);
    assert.match(fn, /if \(!Number\.isFinite\(fraction\)\) return;/);
    assert.match(fn, /if \(endTime <= startTime\) return;/,
        'a zero-length or inverted window would silently never match');
    assert.match(fn, /Math\.max\(0, Math\.min\(1, fraction\)\)/, 'the fraction is clamped to 0..1');
    assert.match(fn, /override == null/, 'null clears');
    assert.match(fn, /_rebuildMasteryFilter\(\)/, 'installing rebuilds the phrase filter');
});

test('every song-reset path drops the override through the single writer', () => {
    // _setOverrideState() is the only writer, so a reset path that nulled
    // _difficultyOverride directly would silently leave the render bundle's
    // view object reporting a stale window.
    assert.equal(extractFunction(src, '_setOverrideState').includes('hwState._difficultyOverride = next'), true);
    const directWrites = src.match(/hwState\._difficultyOverride\s*=(?!=)(?!\s*next;)\s*null;/g) || [];
    assert.deepEqual(directWrites, ['hwState._difficultyOverride = null;'],
        'only the initial declaration may assign the field directly');

    const resets = src.match(/hwState\._phrases = null;(?:\s*\n\s*_setOverrideState\(null\);)/g) || [];
    // init() and reconnect() both reset the ladder; each must drop the
    // song-scoped override on the way.
    assert.equal(resets.length, 2, `expected 2 reset paths, found ${resets.length}`);
});

test('the renderer bundle exposes the override so mastery cannot be misread', () => {
    assert.match(src, /b\.mastery = hwState\._mastery;/,
        'bundle.mastery stays the song-wide value');
    assert.match(src, /b\.difficultyOverride = _overrideViewActive \? _overrideView : null;/,
        'the bundle hands out a reused view object');
    assert.doesNotMatch(src, /b\.difficultyOverride = \{ \.\.\./,
        'the bundle is documented as allocation-free; never re-spread the override per frame');
});