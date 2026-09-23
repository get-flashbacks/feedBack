// Source-level tests for highway.getPhrases() and getMastery() public API getters.
// The createHighway closure is too heavy for a Node sandbox, so tests inspect
// source text to lock in correct wiring — same pattern as highway_filtered_notes.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const highwayJs = path.join(__dirname, '..', '..', 'static', 'highway.js');

test('highway public API exposes getPhrases', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    assert.match(
        src,
        /getPhrases\s*\(\s*\)\s*\{[^}]*_phrases/,
        'getPhrases must reference _phrases',
    );
});

test('getPhrases returns null when _phrases is falsy or empty', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    assert.match(
        src,
        /getPhrases\s*\(\s*\)\s*\{[^}]*!\s*hwState\._phrases[^}]*return null/,
        'getPhrases must return null when no phrase data is available',
    );
});

test('getPhrases maps all documented phrase fields', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    // Match all fields within a reasonable window after getPhrases
    const match = src.match(/getPhrases\s*\(\s*\)([\s\S]{0,400})/);
    assert.ok(match, 'getPhrases not found in highway.js');
    const block = match[1];
    assert.ok(block.includes('start_time'), 'getPhrases must expose start_time');
    assert.ok(block.includes('end_time'), 'getPhrases must expose end_time');
    assert.ok(block.includes('max_difficulty'), 'getPhrases must expose max_difficulty');
    assert.ok(block.includes('index'), 'getPhrases must expose index');
    // Regression guard (CodeRabbit, PR #97): top_difficulty must come from
    // phraseTopDifficulty(p.levels), not just be present as a key -- a
    // regression that quietly replaced it with p.max_difficulty (defeating
    // the whole point of the field for a phrase that completes early) would
    // otherwise still pass the plain block.includes() checks above.
    assert.match(
        block,
        /top_difficulty:\s*phraseTopDifficulty\(p\.levels\s*\|\|\s*\[\]\)/,
        'getPhrases must expose top_difficulty computed via phraseTopDifficulty(p.levels)',
    );
});

test('highway public API exposes getMastery', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    assert.match(
        src,
        /getMastery\s*\(\s*\)\s*\{[^}]*_mastery/,
        'getMastery must reference _mastery',
    );
});
