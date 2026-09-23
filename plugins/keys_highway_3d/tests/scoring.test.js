// Pure MIDI-scoring tests: load screen.js in a bare vm window and exercise
// the __test exports (no DOM, no WebGL, no MIDI device, no network).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load() {
    const window = {
        console,
        location: { protocol: 'http:', host: 'localhost' },
        slopsmith: {},
    };
    window.window = window;
    window.globalThis = window;
    const context = vm.createContext(window);
    const src = fs.readFileSync(path.join(__dirname, '..', 'screen.js'), 'utf8');
    vm.runInContext(src, context, { filename: 'screen.js' });
    return window.slopsmithViz_keys_highway_3d.__test;
}

const TOL = 0.10;

test('accuracyOf/scoreOf mirror the notedetect stats formula', () => {
    const { accuracyOf, scoreOf } = load();
    // accuracy = hits / max(1, hits + misses)
    assert.equal(accuracyOf(0, 0), 0);
    assert.equal(accuracyOf(10, 0), 1);
    assert.equal(accuracyOf(3, 1), 0.75);
    // score = round(hits * 100 * accuracy)
    assert.equal(scoreOf(0, 0), 0);
    assert.equal(scoreOf(10, 0), 1000);
    assert.equal(scoreOf(3, 1), Math.round(3 * 100 * 0.75));
    // Monotonic in accuracy at fixed hits.
    assert.ok(scoreOf(5, 0) > scoreOf(5, 5));
});

test('judgeHit: exact note inside ±0.10 s window hits; outside misses', () => {
    const { judgeHit } = load();
    const notes = [
        { midi: 60, t: 1.0 },
        { midi: 64, t: 1.0 },
        { midi: 62, t: 2.0 },
    ];
    const hitKeys = new Set();
    // On time.
    assert.equal(judgeHit(notes, 60, 1.0, hitKeys, TOL), '1.000|60');
    // Near the edge of the window (the exact ±0.10 boundary is float-
    // representation dependent, same as the piano plugin).
    assert.equal(judgeHit(notes, 62, 2.099, hitKeys, TOL), '2.000|62');
    assert.equal(judgeHit(notes, 64, 0.901, hitKeys, TOL), '1.000|64');
    // Just outside the window.
    assert.equal(judgeHit(notes, 60, 1.11, hitKeys, TOL), null);
    // Wrong note — nothing at that midi anywhere near.
    assert.equal(judgeHit(notes, 65, 1.0, hitKeys, TOL), null);
});

test('judgeHit: dedupes by t|midi — a chart note can only be hit once', () => {
    const { judgeHit } = load();
    const notes = [{ midi: 60, t: 1.0 }, { midi: 60, t: 1.15 }];
    const hitKeys = new Set();
    const first = judgeHit(notes, 60, 1.02, hitKeys, TOL);
    assert.equal(first, '1.000|60');
    hitKeys.add(first);
    // Second strike near the same time falls through to the NEXT un-hit
    // chart note at the same midi (double-stop repeats).
    const second = judgeHit(notes, 60, 1.06, hitKeys, TOL);
    assert.equal(second, '1.150|60');
    hitKeys.add(second);
    // Third strike: both consumed → wrong note.
    assert.equal(judgeHit(notes, 60, 1.1, hitKeys, TOL), null);
});

test('judgeHit: empty/absent chart never judges', () => {
    const { judgeHit } = load();
    assert.equal(judgeHit([], 60, 1.0, new Set(), TOL), null);
    assert.equal(judgeHit(null, 60, 1.0, new Set(), TOL), null);
});

test('hand filter keeps only the selected labelled hand and preserves unlabelled notes', () => {
    const { filterNotationByHand } = load();
    const notes = [
        { midi: 48, t: 1, hand: 'lh' },
        { midi: 72, t: 1, hand: 'rh' },
        { midi: 60, t: 1 },
        { midi: 64, t: 1, hand: 'solo' },
    ];
    assert.equal(filterNotationByHand(notes, 'both'), notes);
    assert.deepEqual(filterNotationByHand(notes, 'left').map(n => n.midi), [48, 60, 64]);
    assert.deepEqual(filterNotationByHand(notes, 'right').map(n => n.midi), [72, 60, 64]);
});

test('hidden-hand chart notes are neutral while unrelated notes remain wrong', () => {
    const { matchesHiddenHandNote } = load();
    const notes = [
        { midi: 48, t: 1, hand: 'lh' },
        { midi: 72, t: 1, hand: 'rh' },
        { midi: 60, t: 1 },
    ];
    assert.equal(matchesHiddenHandNote(notes, 72, 1.05, TOL, 'left'), true);
    assert.equal(matchesHiddenHandNote(notes, 48, 1.05, TOL, 'left'), false);
    assert.equal(matchesHiddenHandNote(notes, 60, 1.05, TOL, 'left'), false);
    assert.equal(matchesHiddenHandNote(notes, 75, 1.05, TOL, 'left'), false);
    assert.equal(matchesHiddenHandNote(notes, 72, 1.05, TOL, 'both'), false);
});

test('miss sweep counts visible and unlabelled notes but not the hidden hand', () => {
    const { filterNotationByHand, sweepMissed } = load();
    const all = [
        { midi: 48, t: 1, hand: 'lh' },
        { midi: 72, t: 1, hand: 'rh' },
        { midi: 60, t: 1 },
    ];
    const missed = [];
    const visible = filterNotationByHand(all, 'left');
    assert.equal(sweepMissed(
        visible, 2, new Set(), new Set(), TOL, null,
        note => missed.push(note.midi),
    ), 2);
    assert.deepEqual(missed, [48, 60]);
});

test('sweepMissed: marks elapsed unhit notes once, respects hit + floor', () => {
    const { sweepMissed, noteKey } = load();
    const notes = [
        { midi: 60, t: 1.0 },
        { midi: 62, t: 1.5 },
        { midi: 64, t: 5.0 },
    ];
    const hitKeys = new Set([noteKey(1.0, 60)]); // 60@1.0 was hit
    const missedKeys = new Set();
    const missed = [];
    // At t=2.0 the windows for 1.0 and 1.5 have elapsed; 5.0 is pending.
    const n1 = sweepMissed(notes, 2.0, hitKeys, missedKeys, TOL, null, n => missed.push(n.midi));
    assert.equal(n1, 1);
    assert.deepEqual(missed, [62]);
    assert.ok(missedKeys.has(noteKey(1.5, 62)));
    // Sweeping again counts nothing new (idempotent per note).
    assert.equal(sweepMissed(notes, 2.1, hitKeys, missedKeys, TOL, null), 0);
    // Floor: a device connected at t=6 must not retro-miss the 5.0 note.
    const hk2 = new Set(), mk2 = new Set();
    assert.equal(sweepMissed(notes, 6.0, hk2, mk2, TOL, 6.0), 0);
});

test('sweepMissed: a note exactly at the connect floor is not retro-missed', () => {
    // Off-by-one guard: floor is the connect instant; a note whose onset
    // equals it (device connected exactly as the onset passed) must be
    // excluded, not swept. Floor comparison is `<=`, not `<`.
    const { sweepMissed } = load();
    const notes = [{ midi: 60, t: 5.0 }, { midi: 62, t: 6.0 }];
    const missedKeys = new Set();
    const missed = [];
    const n = sweepMissed(notes, 7.0, new Set(), missedKeys, TOL, 5.0,
        m => missed.push(m.midi));
    assert.equal(n, 1);
    assert.deepEqual(missed, [62]);
});

test('sweepMissed: a long frame stall cannot let elapsed notes slip past', () => {
    const { sweepMissed } = load();
    const notes = [{ midi: 60, t: 1.0 }, { midi: 62, t: 3.0 }];
    const missedKeys = new Set();
    // The previous sweep ran at t≈0; the next runs 10 s later (backgrounded
    // tab / render hitch). Both elapsed notes must still be counted.
    assert.equal(sweepMissed(notes, 10.0, new Set(), missedKeys, TOL, null), 2);
});

test('sweepMissed: cursor advances monotonically and never recounts', () => {
    const { sweepMissed } = load();
    const notes = [
        { midi: 60, t: 1.0 },
        { midi: 62, t: 2.0 },
        { midi: 64, t: 9.0 },
    ];
    const hitKeys = new Set(), missedKeys = new Set();
    const cursor = { idx: 0 };
    assert.equal(sweepMissed(notes, 1.5, hitKeys, missedKeys, TOL, null, null, cursor), 1);
    assert.equal(cursor.idx, 1);
    // Stall to t=8: the 2.0 note is counted exactly once from the cursor.
    assert.equal(sweepMissed(notes, 8.0, hitKeys, missedKeys, TOL, null, null, cursor), 1);
    assert.equal(cursor.idx, 2);
    // Seek BACKWARDS: the cursor does not rewind, nothing is recounted.
    assert.equal(sweepMissed(notes, 1.5, hitKeys, missedKeys, TOL, null, null, cursor), 0);
    // The cursor still advances past pre-floor notes without counting them.
    const c2 = { idx: 0 };
    const mk2 = new Set();
    assert.equal(sweepMissed(notes, 8.0, new Set(), mk2, TOL, 5.0, null, c2), 0);
    assert.equal(c2.idx, 2);
});

test('sweepStartIndex returns exactly where sweepMissed would stop', () => {
    const { sweepStartIndex, sweepMissed } = load();
    const notes = [
        { midi: 60, t: 1.0 },
        { midi: 62, t: 2.0 },
        { midi: 64, t: 5.0 },
    ];
    const cursor = { idx: 0 };
    assert.equal(sweepMissed(notes, 2.4, new Set(), new Set(), TOL, null, null, cursor), 2);
    assert.equal(cursor.idx, sweepStartIndex(notes, 2.4, TOL));
    assert.equal(sweepStartIndex(notes, 0, TOL), 0);
    assert.equal(sweepStartIndex(notes, 99, TOL), notes.length);
    assert.equal(sweepStartIndex([], 5, TOL), 0);
    assert.equal(sweepStartIndex(null, 5, TOL), 0);
    assert.equal(sweepStartIndex(notes, Number.NaN, TOL), 0);
});

test('mid-run filter change: anchored sweep skips the elapsed tail, still sweeps after', () => {
    // Mirrors _anchorMissSweep on the hand/mastery-filter change path: playable
    // is rebuilt mid-run, the cursor is re-seeded at the current position and
    // a floor set at the change instant. Already-elapsed notes — including
    // ones hit before the change — must never become retroactive misses,
    // while notes that elapse afterwards are swept normally.
    const { sweepStartIndex, sweepMissed, noteKey } = load();
    const notes = [
        { midi: 48, t: 1.0, hand: 'lh' },
        { midi: 60, t: 2.0 },
        { midi: 72, t: 5.0, hand: 'rh' },
    ];
    const hitKeys = new Set([noteKey(1.0, 48)]); // hit before the change
    const missedKeys = new Set();
    const missed = [];
    const cursor = { idx: sweepStartIndex(notes, 3.2, TOL) };
    // t=5.4: the 5.0 note has elapsed; 1.0/2.0 are behind the anchor + floor.
    const n = sweepMissed(notes, 5.4, hitKeys, missedKeys, TOL, 3.2,
        note => missed.push(note.midi), cursor);
    assert.equal(n, 1);
    assert.deepEqual(missed, [72]);
    assert.equal(cursor.idx, 3);
});

test('noteKey quantises time to ms so float drift cannot double-count', () => {
    const { noteKey } = load();
    assert.equal(noteKey(1.0004, 60), noteKey(1.0001, 60));
    assert.notEqual(noteKey(1.002, 60), noteKey(1.0001, 60));
    assert.notEqual(noteKey(1.0, 60), noteKey(1.0, 61));
});

test('classifySeek: rewinds and impossible forward jumps are seeks; playback and stalls are not', () => {
    const { classifySeek } = load();
    // Normal 60 fps playback, and small backward jitter.
    assert.equal(classifySeek(10.0, 10.016, 0.016), null);
    assert.equal(classifySeek(10.0, 9.95, 0.016), null);
    // Paused: song clock frozen while the wall clock runs.
    assert.equal(classifySeek(10.0, 10.0, 5), null);
    // Loop wrap / ← seek.
    assert.equal(classifySeek(10.0, 4.0, 0.016), 'back');
    // → seek / scrub: song time jumped far beyond what one frame explains.
    assert.equal(classifySeek(10.0, 40.0, 0.016), 'forward');
    // A long render stall / backgrounded tab advances both clocks together —
    // NOT a seek (the elapsed notes must still be swept as misses), and 2x
    // playback through that stall isn't one either.
    assert.equal(classifySeek(10.0, 13.5, 3.5), null);
    assert.equal(classifySeek(10.0, 17.0, 3.5), null);
    // Non-finite inputs never classify.
    assert.equal(classifySeek(NaN, 1, 0.016), null);
    assert.equal(classifySeek(1, NaN, 0.016), null);
});

test('loop wrap: forgetting judgments from the rewind point lets a passage be hit again', () => {
    const { judgeHit, noteKey, forgetJudgmentsFrom, sweepMissed, sweepStartIndex } = load();
    const notes = [
        { midi: 60, t: 1.0 },
        { midi: 62, t: 2.0 },
        { midi: 64, t: 3.0 },
    ];
    const hitKeys = new Set([noteKey(1.0, 60), noteKey(2.0, 62)]);
    const missedKeys = new Set([noteKey(3.0, 64)]);
    // Before the fix a replayed note matched nothing (already hit) and
    // scored as a wrong-note miss.
    assert.equal(judgeHit(notes, 60, 1.0, hitKeys, TOL), null);
    // Rewind to t=1.5: only judgments at/after the rewind point are dropped.
    assert.equal(forgetJudgmentsFrom(hitKeys, 1.5 - TOL - 0.05), 1);
    assert.equal(forgetJudgmentsFrom(missedKeys, 1.5 - TOL - 0.05), 1);
    assert.ok(hitKeys.has(noteKey(1.0, 60)), 'a note before the rewind point keeps its hit');
    assert.equal(judgeHit(notes, 62, 2.0, hitKeys, TOL), noteKey(2.0, 62));
    // …and an unplayed pass is swept as missed again from the re-anchored cursor.
    const cursor = { idx: sweepStartIndex(notes, 1.5, TOL) };
    const n = sweepMissed(notes, 3.5, new Set(), missedKeys, TOL, 1.5, null, cursor);
    assert.equal(n, 2);
});

test('forward seek: re-anchoring the sweep does not dump skipped notes in as misses', () => {
    const { sweepMissed, sweepStartIndex } = load();
    const notes = Array.from({ length: 100 }, (_, i) => ({ midi: 60, t: 5 + i * 0.5 }));
    // Unanchored (the old behaviour): every skipped note counts.
    assert.equal(sweepMissed(notes, 60, new Set(), new Set(), TOL, null, null, { idx: 0 }), 100);
    // Anchored at the seek target, as _onSeek does.
    const cursor = { idx: sweepStartIndex(notes, 30, TOL) };
    assert.equal(sweepMissed(notes, 30.05, new Set(), new Set(), TOL, 30, null, cursor), 0);
});
