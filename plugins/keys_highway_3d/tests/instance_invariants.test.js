// Source-level guards for renderer-instance fixes that can't run headless
// here (they need three.js + WebGL): the stateful paths live inside
// createFactory() and are only reachable through init(). Same strategy as
// tests/js/drum_keys_highway_3d_resize_reframe.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// path.resolve/path.join alone still reads as "dynamically constructed path"
// to CWE-22-style scanners regardless of the fact that every segment here is
// a literal — prove containment explicitly: resolve, then verify the result
// never leaves the plugin directory before it's handed to fs.readFileSync.
const PLUGIN_DIR = path.resolve(__dirname, '..');
const SCREEN_JS_PATH = path.resolve(PLUGIN_DIR, 'screen.js');
if (path.relative(PLUGIN_DIR, SCREEN_JS_PATH).startsWith('..')) {
    throw new Error('screen.js path escaped the plugin directory');
}
const src = fs.readFileSync(SCREEN_JS_PATH, 'utf8');

test('a hit or scoring reset restores a key flashing red, not just forgets it', () => {
    // The wrong-note flash overwrites the key's emissive COLOR; the per-frame
    // approach glow only drives intensity, so a bare _keyFlash.delete/clear
    // left the key glowing red for every later approaching note.
    assert.match(src,
        /function _cancelKeyFlash\(midi\)\s*\{[\s\S]*?emissive\.setHex\(mesh\.userData\.origEmissive\)/);
    assert.match(src, /_cancelKeyFlash\(playedMidi\);\s*\/\/ a hit cancels/);
    assert.doesNotMatch(src, /_keyFlash\.delete\(playedMidi\)/);
    const reset = src.match(/function _resetScoring\(\)\s*\{[\s\S]*?\n {8}\}/);
    assert.ok(reset, '_resetScoring not found');
    assert.match(reset[0], /_cancelAllKeyFlashes\(\)/);
    assert.doesNotMatch(reset[0], /_keyFlash\.clear\(\)/);
});

test('updateScene detects seeks before the miss sweep', () => {
    const body = src.match(/function updateScene\(now\)\s*\{[\s\S]*?\n {8}\}\n/);
    assert.ok(body, 'updateScene not found');
    const seekAt = body[0].search(/classifySeek\(_latestTime,\s*now,/);
    const sweepAt = body[0].search(/sweepMissed\(/);
    assert.ok(seekAt > 0 && sweepAt > seekAt, 'seek handling must run before sweepMissed');
    // Scope to _onSeek's own body (a single bounded match) rather than one
    // regex chaining two unbounded [\s\S]* wildcards, which static analysis
    // flags as a polynomial-backtracking (ReDoS) shape regardless of the
    // fact that it only ever matches this fixed local source file.
    const onSeek = src.match(/function _onSeek\(kind, now\)\s*\{[\s\S]*?\n {8}\}\n/);
    assert.ok(onSeek, '_onSeek not found');
    const forgetAt = onSeek[0].search(/forgetJudgmentsFrom\(_hitNoteKeys/);
    const anchorAt = onSeek[0].search(/_anchorMissSweep\(now\)/);
    assert.ok(forgetAt > 0 && anchorAt > forgetAt,
        '_onSeek must forget judgments before re-anchoring the sweep');
});

test('a superseded init() cannot build a second renderer', () => {
    assert.match(src, /const myInit = \+\+_initGen;/);
    assert.match(src, /if \(!highwayCanvas \|\| myInit !== _initGen\) return;/);
    assert.match(src, /destroy\(\) \{\s*_initGen\+\+;/);
});

test('the chart comes from this highway\'s own song_info (per split panel)', () => {
    // The arrangement must come from bundle.songInfo, not the global
    // currentSong (which only knows the main player's arrangement).
    assert.match(src, /Number\.isInteger\(info\.arrangement_index\)\) arr = info\.arrangement_index;/);
    assert.match(src, /const ref = _chartRef\(bundle, false, true\);\s*if \(ref\) loadNotationForCurrentSong\(ref\);/);
    assert.doesNotMatch(src, /on\('song:loaded'/);
});

test('a live sharp-layout / octave-gap change rebuilds lanes and notes together', () => {
    assert.match(src, /function _rebuildChartGeometry\(\)\s*\{[\s\S]*?buildKeyboardAndHighway\(\);\s*buildNoteMeshes\(\);/);
    assert.match(src, /_sharpMode = d\.sharpMode;\s*_rebuildChartGeometry\(\);/);
    assert.match(src, /if \('octaveGaps' in d\.fx\) _rebuildChartGeometry\(\);/);
});
