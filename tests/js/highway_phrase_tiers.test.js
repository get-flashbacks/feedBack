// Covers the master-difficulty slider -> phrase level mapping. The helpers
// live at module scope in static/highway.js; they are extracted and run
// directly, the same way highway_chart_transform.test.js exercises its
// staging helpers.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// A literal specifier resolved by the module system (no runtime path
// construction); highway.js itself is not loaded, only read.
const highwayJs = require.resolve('../../static/highway.js');

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

const src = fs.readFileSync(highwayJs, 'utf8');
// The helpers are pure and dependency-free, so they run in an empty vm
// context; their top-level declarations land on the sandbox.
const sandbox = {};
vm.runInNewContext([
    extractFunction(src, 'phraseLevelTiers'),
    extractFunction(src, 'phraseLevelIndexForMastery'),
    extractFunction(src, 'phraseTopDifficulty'),
].join('\n'), sandbox);
const { phraseLevelIndexForMastery, phraseTopDifficulty } = sandbox;

const levels = (...diffs) => diffs.map((difficulty) => ({ difficulty }));
const pick = (lv, max, m) => phraseLevelIndexForMastery(lv, max, m);

test('a fully authored ladder maps exactly like floor(mastery * n)', () => {
    const lv = levels(0, 1, 2, 3);
    for (const m of [0, 0.1, 0.25, 0.49, 0.5, 0.74, 0.75, 0.99, 1]) {
        assert.equal(pick(lv, 3, m), Math.min(3, Math.floor(m * 4)), `mastery ${m}`);
    }
});

test('sparse tiers keep each level on its own slider band', () => {
    // Content changes at tiers 0, 1 and 3 of a 4-tier scale.
    const lv = levels(0, 1, 3);
    assert.equal(pick(lv, 3, 0.0), 0);
    assert.equal(pick(lv, 3, 0.3), 1);
    assert.equal(pick(lv, 3, 0.6), 1, 'tier 2 still plays the tier-1 level');
    assert.equal(pick(lv, 3, 0.8), 2);
    assert.equal(pick(lv, 3, 1.0), 2);
});

test('a phrase complete early plays in full from its top tier on', () => {
    const lv = levels(0, 1);
    assert.equal(pick(lv, 3, 0.2), 0);
    assert.equal(pick(lv, 3, 0.25), 1, 'full content from the second of four bands, not from 50%');
});

test('single-level and malformed ladders fall back safely', () => {
    assert.equal(pick(levels(0), 0, 0.9), 0);
    assert.equal(pick([{}, {}, {}], 2, 0.5), 1, 'missing numbers -> positional');
    assert.equal(pick(levels(0, 2, 1), 2, 0.9), 2, 'non-increasing numbers -> positional');
    assert.equal(pick(levels(0, 1, 2), undefined, 0.5), 1, 'missing max_difficulty uses the last tier');
});

test('phraseTopDifficulty reports the tier the phrase is complete at', () => {
    assert.equal(phraseTopDifficulty(levels(0, 1, 2, 3)), 3);
    assert.equal(phraseTopDifficulty(levels(0, 1)), 1);
    assert.equal(phraseTopDifficulty(levels(0)), 0);
    assert.equal(phraseTopDifficulty([{}, {}, {}]), 2);
});

test('the mastery filter selects levels through the tier helper', () => {
    const fn = extractFunction(src, '_rebuildMasteryFilter');
    assert.match(fn, /phraseLevelIndexForMastery\(p\.levels, p\.max_difficulty, hwState\._mastery\)/);
});
