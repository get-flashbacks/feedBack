// Source-level guards for renderer-instance fixes that can't run headless
// here (they need three.js + WebGL): the stateful paths live inside
// createFactory() and are only reachable through init(). Same strategy as
// tests/js/drum_keys_highway_3d_resize_reframe.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// require.resolve('../screen.js') is a literal argument resolved by the
// CommonJS module system itself — unlike path.join/resolve(__dirname, ...)
// (even wrapped in a manual containment check), there's no runtime path
// construction here at all for a CWE-22-style scanner to flag.
const src = fs.readFileSync(require.resolve('../screen.js'), 'utf8');

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

test('a mastery change keeps the run totals instead of resetting scoring', () => {
    // Difficulty Ladder drives mastery during play; wiping hits/misses/streak
    // on every adjustment made the run's posted stats cover only the time
    // since the last change. Judged-note keys are (t, midi)-keyed, so they
    // survive the playable rebuild; only the sweep cursor needs re-anchoring.
    const fn = src.match(/function _maybeApplyMasteryFilter\(bundle, now\)\s*\{[\s\S]*?\n {8}\}\n/);
    assert.ok(fn, '_maybeApplyMasteryFilter not found');
    assert.doesNotMatch(fn[0], /_resetScoring\(\)/);
    assert.match(fn[0], /_anchorMissSweep\(now\)/);
});

test('updateScene windows its arrays instead of walking every note (feedBack#95)', () => {
    // The window helpers are pure and unit-tested in data_layer.test.js, but
    // nothing there can catch them being exported and never wired up — the
    // per-frame cost fix lives entirely inside createFactory(). So pin the
    // wiring: both t-sorted arrays advance a window once per frame, both
    // per-frame loops walk [lo, hi), and neither still iterates the whole
    // array (the camera loop's own dt filter stays inside the window).
    const body = src.match(/function updateScene\(now\)\s*\{[\s\S]*?\n {8}\}\n/);
    assert.ok(body, 'updateScene not found');
    // Pin the bound pairing too: behind-with-minus / ahead-with-plus, so a
    // swapped sign or swapped helper can't slip through the weaker form.
    assert.match(body[0],
        /advanceTWindow\(_noteMeshT, noteMeshes,\s*\n\s*now - noteWindowBehindS\(_maxNoteLen\),\s*\n\s*now \+ noteWindowAheadS\(HIGHWAY_LEN, hitZ\),/);
    assert.match(body[0],
        /advanceTWindow\(_markerT, markerSprites,\s*\n\s*now - MARKER_WIN_BEHIND_S,\s*\n\s*now \+ noteWindowAheadS\(HIGHWAY_LEN, hitZ\),/);
    assert.match(body[0], /for \(let i = _noteWin\.lo; i < _noteWin\.hi; i\+\+\)/);
    assert.match(body[0], /for \(let i = _markerWin\.lo; i < _markerWin\.hi; i\+\+\)/);
    assert.doesNotMatch(body[0], /of noteMeshes|of markerSprites/);
    // Entries leaving the window are parked exactly once, here — not
    // rediscovered per frame by the loops they just left.
    assert.match(body[0], /_noteWin, _hideNoteWindow\)/);
    assert.match(body[0], /_markerWin, _hideMarkerWindow\)/);
});

test('every noteMeshes/markerSprites reassignment resets its draw window', () => {
    // The window's indices are only valid for the array they were taken
    // from: a build or teardown that swaps the array without resetting the
    // window would hand _hideNoteWindow stale indices from the previous one
    // (TypeError on the first advance after the swap). The declaration lines
    // (`let noteMeshes = []`) don't match — only reassignments do.
    const stmts = [...src.matchAll(/^[ \t]+(noteMeshes|markerSprites) = \[\];$/gm)];
    assert.equal(stmts.length, 4, 'expected exactly the 4 known reassignments');
    for (const m of stmts) {
        const win = m[1] === 'noteMeshes' ? '_noteWin' : '_markerWin';
        const after = src.slice(m.index, m.index + 400);
        assert.match(after, new RegExp(win + '\\.lo = ' + win + '\\.hi = -1;'),
            `${m[1]} reassignment (line ${src.slice(0, m.index).split('\n').length}) must reset ${win} beside it`);
    }
});
