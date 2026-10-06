// Pure data-layer tests: load screen.js in a bare vm window and exercise the
// __test exports (no DOM, no WebGL, no network).
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

test('beatDurSec: base, dotted, double-dotted, tuplet', () => {
    const { beatDurSec } = load();
    // 120 BPM → quarter = 0.5s
    assert.equal(beatDurSec({ dur: 4 }, 120), 0.5);
    assert.equal(beatDurSec({ dur: 2 }, 120), 1.0);
    assert.equal(beatDurSec({ dur: 8 }, 120), 0.25);
    // dotted quarter = 0.75s; double-dotted = 0.875s
    assert.equal(beatDurSec({ dur: 4, dot: 1 }, 120), 0.75);
    assert.equal(beatDurSec({ dur: 4, dot: 2 }, 120), 0.875);
    // triplet eighth: 0.25 * 2/3
    assert.ok(Math.abs(beatDurSec({ dur: 8, tu: [3, 2] }, 120) - 0.25 * 2 / 3) < 1e-9);
    // invalid → null
    assert.equal(beatDurSec({ dur: 0 }, 120), null);
    assert.equal(beatDurSec({ dur: 4 }, null), null);
});

function measure(idx, t, opts = {}) {
    return { idx, t, ...opts };
}

test('flattenNotation: basic two-hand flatten, sorted, durSec from tempo', () => {
    const { flattenNotation } = load();
    const notes = flattenNotation([
        {
            idx: 1, t: 0, tempo: 120,
            staves: {
                rh: { voices: [{ v: 1, beats: [
                    { t: 0.5, dur: 4, notes: [{ midi: 64 }] },
                    { t: 1.0, dur: 8, notes: [{ midi: 67 }] },
                ] }] },
                lh: { voices: [{ v: 1, beats: [
                    { t: 0.0, dur: 2, notes: [{ midi: 48 }] },
                ] }] },
            },
        },
    ]);
    assert.equal(notes.length, 3);
    assert.deepEqual(JSON.parse(JSON.stringify(notes.map(n => n.midi))), [48, 64, 67]); // time-sorted
    assert.equal(notes[0].hand, 'lh');
    assert.equal(notes[0].durSec, 1.0);   // half at 120
    assert.equal(notes[1].durSec, 0.5);   // quarter
    assert.equal(notes[2].durSec, 0.25);  // eighth
    assert.equal(notes[1].measureIdx, 1);
});

test('flattenNotation: tempo state carries across measures and changes apply', () => {
    const { flattenNotation } = load();
    const notes = flattenNotation([
        measure(1, 0, { tempo: 120, staves: { rh: { voices: [{ v: 1, beats: [{ t: 0, dur: 4, notes: [{ midi: 60 }] }] }] } } }),
        measure(2, 2, { staves: { rh: { voices: [{ v: 1, beats: [{ t: 2, dur: 4, notes: [{ midi: 62 }] }] }] } } }),
        measure(3, 4, { tempo: 60, staves: { rh: { voices: [{ v: 1, beats: [{ t: 4, dur: 4, notes: [{ midi: 64 }] }] }] } } }),
    ]);
    assert.equal(notes[0].durSec, 0.5); // 120 BPM
    assert.equal(notes[1].durSec, 0.5); // tempo carried
    assert.equal(notes[2].durSec, 1.0); // 60 BPM
});

test('flattenNotation: tied notes extend instead of emitting a new block', () => {
    const { flattenNotation } = load();
    const notes = flattenNotation([
        {
            idx: 1, t: 0, tempo: 120,
            staves: { rh: { voices: [{ v: 1, beats: [
                { t: 0.0, dur: 2, notes: [{ midi: 60 }] },
                { t: 1.0, dur: 2, notes: [{ midi: 60, tied: true }] },
            ] }] } },
        },
    ]);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].durSec, 2.0); // half + tied half
});

test('flattenNotation: no tempo anywhere falls back to next-onset gap', () => {
    const { flattenNotation } = load();
    const notes = flattenNotation([
        {
            idx: 1, t: 0,
            staves: { rh: { voices: [{ v: 1, beats: [
                { t: 0.0, dur: 4, notes: [{ midi: 60 }] },
                { t: 0.8, dur: 4, notes: [{ midi: 62 }] },
            ] }] } },
        },
    ]);
    assert.ok(Math.abs(notes[0].durSec - 0.8) < 1e-9);
    assert.equal(notes[1].durSec, 2.0); // final-beat fallback
});

test('flattenNotation: overlap clamp against next same-hand same-midi onset', () => {
    const { flattenNotation } = load();
    const notes = flattenNotation([
        {
            idx: 1, t: 0, tempo: 30, // whole note = 8s — way past the next onset
            staves: { rh: { voices: [{ v: 1, beats: [
                { t: 0.0, dur: 1, notes: [{ midi: 60 }] },
                { t: 1.0, dur: 1, notes: [{ midi: 60 }] },
            ] }] } },
        },
    ]);
    assert.equal(notes[0].durSec, 1.0); // clamped to next onset
});

test('flattenNotation: rests, malformed beats, and out-of-range midi are skipped', () => {
    const { flattenNotation } = load();
    const notes = flattenNotation([
        {
            idx: 1, t: 0, tempo: 120,
            staves: { rh: { voices: [{ v: 1, beats: [
                { t: 0.0, dur: 4, rest: true },
                { t: 0.5, dur: 4, notes: [{ midi: 200 }] },
                null,
                { t: 1.0, dur: 4, notes: [{ midi: 64 }] },
            ] }] } },
        },
    ]);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].midi, 64);
});

test('keyRange pads and clamps to the 88-key piano, keeps active span explicit', () => {
    const { keyRange } = load();
    assert.deepEqual(
        JSON.parse(JSON.stringify(keyRange([{ midi: 60 }, { midi: 72 }]))),
        { low: 58, high: 74, activeLow: 60, activeHigh: 72 },
    );
    // At the clamp edges the active span still reflects the chart extremes
    // (not low+pad — that would mark A0/C8 inactive when actually played).
    assert.deepEqual(
        JSON.parse(JSON.stringify(keyRange([{ midi: 21 }, { midi: 108 }]))),
        { low: 21, high: 108, activeLow: 21, activeHigh: 108 },
    );
    const empty = keyRange([]);
    assert.ok(empty.low < 60 && empty.high > 60);
    assert.ok(empty.activeLow > empty.activeHigh, 'empty chart has an empty active span');
});

test('noteLetter maps midi to pitch-class letters', () => {
    const { noteLetter } = load();
    assert.equal(noteLetter(60), 'C');
    assert.equal(noteLetter(61), 'C#');
    assert.equal(noteLetter(69), 'A');
    assert.equal(noteLetter(71), 'B');
    assert.equal(noteLetter(72), 'C');  // octave wraps
    assert.equal(noteLetter(21), 'A');  // A0
});

test('scrollZ: events sit at hitZ exactly at their time and approach from -Z', () => {
    const { scrollZ } = load();
    const hitZ = -0.5, speed = 2.0;
    // At now === eventT the event is exactly on the hit-line.
    assert.equal(scrollZ(10, 10, hitZ, speed), hitZ);
    // 1s before its time it is `speed` units further away (towards -Z).
    assert.equal(scrollZ(10, 9, hitZ, speed), hitZ - speed);
    // After its time it has moved past the hit-line (towards +Z).
    assert.equal(scrollZ(10, 11, hitZ, speed), hitZ + speed);
    // Marker and note-front-edge maths agree by construction: a note of
    // length L positioned at scrollZ(t) - L/2 has its front edge at
    // scrollZ(t).
    const len = 0.8;
    assert.equal(scrollZ(10, 10, hitZ, speed) - len / 2 + len / 2, hitZ);
});

test('measureMarkers extracts idx/t pairs', () => {
    const { measureMarkers } = load();
    assert.deepEqual(
        JSON.parse(JSON.stringify(measureMarkers([{ idx: 1, t: 0 }, { idx: 2, t: 2.5 }, { bogus: true }]))),
        [{ idx: 1, t: 0 }, { idx: 2, t: 2.5 }],
    );
});

// ── Difficulty-ladder-aware notation filtering (feedBack#67) ───────────────

test('filterNotationByMastery: returns the same array reference when there is no phrase data', () => {
    const { filterNotationByMastery } = load();
    const notes = [{ midi: 60, t: 0 }, { midi: 62, t: 1 }];
    assert.equal(filterNotationByMastery(notes, [], [{ t: 0 }], []), notes);
    assert.equal(filterNotationByMastery(notes, null, [{ t: 0 }], []), notes);
});

test('filterNotationByMastery: returns the same array reference when the tab has no filtered content at all', () => {
    const { filterNotationByMastery } = load();
    const notes = [{ midi: 60, t: 0 }];
    const phrases = [{ start_time: 0, end_time: 10, max_difficulty: 3 }];
    assert.equal(filterNotationByMastery(notes, phrases, null, undefined), notes);
});

test('filterNotationByMastery: drops notation onsets inside a phrase the tab filtered to empty', () => {
    const { filterNotationByMastery } = load();
    const notes = [
        { midi: 60, t: 0.5 },  // inside phrase A (0..5) — A has no filtered tab content
        { midi: 62, t: 5.5 },  // inside phrase B (5..10) — B has filtered tab content
    ];
    const phrases = [
        { start_time: 0, end_time: 5, max_difficulty: 3 },
        { start_time: 5, end_time: 10, max_difficulty: 3 },
    ];
    const tabNotes = [{ t: 6.0 }]; // only in phrase B's window
    const out = filterNotationByMastery(notes, phrases, tabNotes, []);
    assert.deepEqual(out.map(n => n.midi), [62]);
});

test('filterNotationByMastery: a boundary-crossing measure keeps only the events whose OWN onset is playable', () => {
    // Simulates one notation measure spanning two phrases — filtering is
    // per-onset, so the measure isn't deleted wholesale over one phrase.
    const { filterNotationByMastery } = load();
    const notes = [
        { midi: 60, t: 3.9, measureIdx: 0 }, // phrase A (0..4) — playable
        { midi: 62, t: 4.1, measureIdx: 0 }, // phrase B (4..8) — NOT playable
    ];
    const phrases = [
        { start_time: 0, end_time: 4, max_difficulty: 2 },
        { start_time: 4, end_time: 8, max_difficulty: 2 },
    ];
    const tabNotes = [{ t: 1.0 }]; // only phrase A has filtered content
    const out = filterNotationByMastery(notes, phrases, tabNotes, []);
    assert.deepEqual(out.map(n => n.midi), [60]);
});

test('filterNotationByMastery: chord onsets (not just notes) count toward phrase playability', () => {
    const { filterNotationByMastery } = load();
    const notes = [{ midi: 60, t: 2 }];
    const phrases = [{ start_time: 0, end_time: 5, max_difficulty: 1 }];
    const out = filterNotationByMastery(notes, phrases, [], [{ t: 4.9 }]);
    assert.deepEqual(out.map(n => n.midi), [60]);
});

test('filterNotationByMastery: an onset outside every phrase window fails OPEN (kept)', () => {
    const { filterNotationByMastery } = load();
    const notes = [{ midi: 60, t: 99 }]; // no phrase covers this
    const phrases = [{ start_time: 0, end_time: 5, max_difficulty: 1 }];
    const out = filterNotationByMastery(notes, phrases, [{ t: 1 }], []);
    assert.deepEqual(out.map(n => n.midi), [60]);
});

test('filterNotationByMastery: half-open windows — an onset exactly at end_time belongs to the NEXT phrase', () => {
    const { filterNotationByMastery } = load();
    const notes = [{ midi: 60, t: 5 }]; // exactly phrase A's end_time / phrase B's start_time
    const phrases = [
        { start_time: 0, end_time: 5, max_difficulty: 1 },  // empty at current mastery
        { start_time: 5, end_time: 10, max_difficulty: 1 }, // has content
    ];
    const out = filterNotationByMastery(notes, phrases, [{ t: 5 }], []);
    assert.deepEqual(out.map(n => n.midi), [60]); // attributed to phrase B, which is playable
});

test('filterNotationByMastery: unsorted phrase input is handled (sorted internally)', () => {
    const { filterNotationByMastery } = load();
    const notes = [{ midi: 60, t: 6 }, { midi: 61, t: 1 }];
    const phrasesOutOfOrder = [
        { start_time: 5, end_time: 10, max_difficulty: 1 }, // has content
        { start_time: 0, end_time: 5, max_difficulty: 1 },  // empty
    ];
    const out = filterNotationByMastery(notes, phrasesOutOfOrder, [{ t: 7 }], []);
    assert.deepEqual(out.map(n => n.midi), [60]);
});

test('_pickMidiTarget: no plugin-local pick defers to the domain-wide selection, not "first device"', () => {
    const { _pickMidiTarget } = load();
    const inputs = [
        { id: 'a', name: 'Device A', key: 'web-midi::a' },
        { id: 'b', name: 'Device B', key: 'web-midi::b' },
    ];
    // Fresh install / never picked here — must use the Input Setup global,
    // NOT fall through to inputs[0].
    const target = _pickMidiTarget(inputs, null, 'web-midi::b', true);
    assert.equal(target.id, 'b');
});

test('_pickMidiTarget: the domain-wide selection is the source of truth — it wins over a stale plugin-local pick', () => {
    const { _pickMidiTarget } = load();
    const inputs = [
        { id: 'a', name: 'Device A', key: 'web-midi::a' },
        { id: 'b', name: 'Device B', key: 'web-midi::b' },
    ];
    // A stale local pick (e.g. left by a pre-fix build's auto-connect) must
    // NOT override the device the user configured in Settings → Input Setup.
    const target = _pickMidiTarget(inputs, { id: 'a', name: 'Device A', key: 'web-midi::a' }, 'web-midi::b', true);
    assert.equal(target.id, 'b');
});

test('_pickMidiTarget: local pick is used as a fallback when no global is configured', () => {
    const { _pickMidiTarget } = load();
    const inputs = [
        { id: 'a', name: 'Device A', key: 'web-midi::a' },
        { id: 'b', name: 'Device B', key: 'web-midi::b' },
    ];
    const target = _pickMidiTarget(inputs, { id: 'a', name: 'Device A', key: 'web-midi::a' }, null, true);
    assert.equal(target.id, 'a');
});

test('_pickMidiTarget: local pick name-recovers when its logicalSourceKey went stale (id regeneration)', () => {
    const { _pickMidiTarget } = load();
    // Same physical device, new id/key across a reload; the saved key/id miss
    // but the name still matches.
    const inputs = [{ id: 'a2', name: 'Device A', key: 'web-midi::a2' }];
    const target = _pickMidiTarget(inputs, { id: 'a1', name: 'Device A', key: 'web-midi::a1' }, null, true);
    assert.equal(target.id, 'a2');
});

test('_pickMidiTarget: domain-wide selection is ignored if it names a blocklisted loopback port', () => {
    const { _pickMidiTarget } = load();
    const inputs = [
        { id: 'thru', name: 'IAC Driver Bus 1', key: 'web-midi::thru' },
        { id: 'b', name: 'Device B', key: 'web-midi::b' },
    ];
    const target = _pickMidiTarget(inputs, null, 'web-midi::thru', true);
    assert.equal(target.id, 'b'); // falls through to the first non-loopback device
});

test('_pickMidiTarget: when every present device is a loopback, connect to nothing (never a dead port)', () => {
    const { _pickMidiTarget } = load();
    const inputs = [
        { id: 'thru', name: 'MIDI Through Port-0', key: 'web-midi::thru' },
        { id: 'iac', name: 'IAC Driver Bus 1', key: 'web-midi::iac' },
    ];
    // No non-loopback device exists — must NOT fall back to inputs[0] (a port
    // that carries no input and would silently eat every note).
    const target = _pickMidiTarget(inputs, null, null, true);
    assert.equal(target, null);
});

test('_pickMidiTarget: explicit "None" opt-out still wins over any global default', () => {
    const { _pickMidiTarget } = load();
    const inputs = [{ id: 'a', name: 'Device A', key: 'web-midi::a' }];
    const target = _pickMidiTarget(inputs, { id: '', name: '' }, 'web-midi::a', true);
    assert.equal(target, null);
});

test('_pickMidiTarget: a present global wins even during hotplug recovery', () => {
    const { _pickMidiTarget } = load();
    const inputs = [{ id: 'b', name: 'Device B', key: 'web-midi::b' }];
    // The configured global device is present — reconnect to it, don't bail.
    const target = _pickMidiTarget(inputs, null, 'web-midi::b', false);
    assert.equal(target.id, 'b');
});

test('_pickMidiTarget: recovery (allowFallback=false) preserves an absent configured device instead of grabbing a random one', () => {
    const { _pickMidiTarget } = load();
    const inputs = [{ id: 'b', name: 'Device B', key: 'web-midi::b' }];
    // The configured device ('x', global) is currently unplugged; a transient
    // recovery must NOT switch to the unrelated device that is present.
    const target = _pickMidiTarget(inputs, null, 'web-midi::x', false);
    assert.equal(target, null);
});

test('_pickMidiTarget: recovery with no preference at all still allows a first-hotplug grab', () => {
    const { _pickMidiTarget } = load();
    const inputs = [{ id: 'b', name: 'Device B', key: 'web-midi::b' }];
    const target = _pickMidiTarget(inputs, null, null, false);
    assert.equal(target.id, 'b');
});

/* ── updateScene's draw window (feedBack#95) ───────────────────────────── */

test('noteWindowAheadS: the bound is exactly where a note front edge leaves the runway', () => {
    const { noteWindowAheadS, scrollZ, TS } = load();
    const highwayLen = 8.625, hitZ = -0.1725;
    const ahead = noteWindowAheadS(highwayLen, hitZ);
    // scrollZ positions the note front at its onset; the runway hides the
    // note once frontZ < -highwayLen. The bound must sit exactly on that
    // crossing (at the module's TS — the speed updateScene scrolls at).
    assert.ok(Math.abs(scrollZ(ahead, 0, hitZ, TS) - (-highwayLen)) < 1e-9);
    assert.ok(scrollZ(ahead - 1e-6, 0, hitZ, TS) > -highwayLen);  // just inside: on the runway
    assert.ok(scrollZ(ahead + 1e-6, 0, hitZ, TS) < -highwayLen);  // just past: off it
    assert.ok(ahead > 0);
});

test('noteWindowBehindS: covers the longest note\'s consumption AND the label fade', () => {
    const { noteWindowBehindS, TS, LABEL_FADE_DIST } = load();
    // Long-note case binds: a 4-second note is still being consumed 4 s
    // after its onset, so the window must reach at least that far back.
    const maxLen = 4 * TS;
    assert.ok(noteWindowBehindS(maxLen) * TS >= maxLen);
    // Short-note case binds the label: a note consumed in one frame still
    // shows its name for LABEL_FADE_DIST past the hit-line — a bound built
    // from note length alone ((0 + 20K)/TS) would cut the label off early.
    assert.ok(noteWindowBehindS(0) * TS >= LABEL_FADE_DIST);
    // Tightness: beyond the label floor the bound tracks only the longest
    // note — it must not grow with the chart's length or total entry count.
    assert.ok(noteWindowBehindS(maxLen) * TS <= maxLen + LABEL_FADE_DIST);
    // Monotone: a longer chart note only ever widens the window.
    let prev = -Infinity;
    for (let len = 0; len <= 60; len += 0.25) {
        const behind = noteWindowBehindS(len);
        assert.ok(behind >= prev);
        assert.ok(behind > 0);
        prev = behind;
    }
});

test('the note window contains every filter band updateScene runs inside it', () => {
    const { noteWindowAheadS, noteWindowBehindS } = load();
    // updateScene's camera framing keeps only dt ∈ [-0.4, CAM_ZOOM_AHEAD]
    // and its key-approach glow dt ∈ [-0.05, KEY_GLOW_AHEAD]; both filters
    // run inside the window slices, so a band edge that crept outside the
    // window would silently truncate the filter while everything else stayed
    // green. Stock literals mirror screen.js: 0.4 (camera lag, hardcoded at
    // the call site), CAM_ZOOM_AHEAD = 3.5, KEY_GLOW_AHEAD = 2.0.
    assert.ok(noteWindowBehindS(0) >= 0.4);
    assert.ok(noteWindowBehindS(0) >= 0.05);
    // Stock geometry: HIGHWAY_LEN = 1150*K = 8.625, hitZ = -WHITE_L/2 = -0.1725.
    const ahead = noteWindowAheadS(8.625, -0.1725);
    assert.ok(ahead >= 3.5);  // CAM_ZOOM_AHEAD's far edge; also covers the glow's 2.0
});

test('advanceTWindow: a fresh window claims its slice without hiding anything', () => {
    const { advanceTWindow, _noteMeshT } = load();
    const entries = [0, 1, 2, 3, 4].map(t => ({ note: { t } }));
    const win = { lo: -1, hi: -1 };
    const hidden = [];
    advanceTWindow(_noteMeshT, entries, 1.5, 3.5, win, (lo, hi) => hidden.push([lo, hi]));
    // Entries start hidden after a rebuild, so the first claim hides nothing.
    assert.deepEqual(hidden, []);
    assert.deepEqual([win.lo, win.hi], [2, 4]);  // t ∈ [1.5, 3.5] → entries 2..3
});

test('advanceTWindow: steady playback hides only the run that fell out behind', () => {
    const { advanceTWindow, _noteMeshT } = load();
    const entries = [0, 1, 2, 3, 4, 5].map(t => ({ note: { t } }));
    const win = { lo: -1, hi: -1 };
    const hidden = [];
    advanceTWindow(_noteMeshT, entries, 1.5, 3.5, win, (lo, hi) => hidden.push([lo, hi]));
    hidden.length = 0;
    advanceTWindow(_noteMeshT, entries, 2.5, 4.5, win, (lo, hi) => hidden.push([lo, hi]));
    assert.deepEqual(hidden, [[2, 3]]);  // only t=2 fell out behind; nothing left ahead
    assert.deepEqual([win.lo, win.hi], [3, 5]);  // t ∈ [2.5, 4.5] → entries 3..4
});

test('advanceTWindow: a forward seek hides its jumped-past window; a rewind re-claims it', () => {
    const { advanceTWindow, _noteMeshT } = load();
    const entries = [0, 1, 2, 3, 4, 5].map(t => ({ note: { t } }));
    const win = { lo: -1, hi: -1 };
    const hidden = [];
    advanceTWindow(_noteMeshT, entries, 0.5, 2.5, win, (lo, hi) => hidden.push([lo, hi]));
    hidden.length = 0;
    // Forward seek past the chart end: window collapses to [6, 6) and the
    // whole old front falls behind. The hide range runs to the new lo, which
    // sweeps up entries that were already hidden (re-hiding is idempotent)
    // — that keeps "everything below lo is hidden" a single enforced rule.
    advanceTWindow(_noteMeshT, entries, 9.5, 11.5, win, (lo, hi) => hidden.push([lo, hi]));
    assert.deepEqual(hidden, [[1, 6]]);
    assert.deepEqual([win.lo, win.hi], [6, 6]);
    // Rewind back over previously visited territory: the old window was
    // empty so its lower edge hides nothing; the entries that re-enter
    // below lo belong to the caller to process, never to onHide. Everything
    // the shrunk upper edge outruns is (already-hidden) ahead-of-window
    // entries — hidden again, harmlessly.
    hidden.length = 0;
    advanceTWindow(_noteMeshT, entries, 0.5, 2.5, win, (lo, hi) => hidden.push([lo, hi]));
    assert.deepEqual(hidden, [[3, 6]]);
    assert.deepEqual([win.lo, win.hi], [1, 3]);
});

test('advanceTWindow: same-onset entries (chords) enter and leave as one run', () => {
    const { advanceTWindow, _noteMeshT } = load();
    const entries = [
        { note: { t: 0 } },
        { note: { t: 1 } }, { note: { t: 1 } }, { note: { t: 1 } },
        { note: { t: 2 } },
    ];
    const win = { lo: -1, hi: -1 };
    const hidden = [];
    advanceTWindow(_noteMeshT, entries, 1, 1, win, (lo, hi) => hidden.push([lo, hi]));
    assert.deepEqual([win.lo, win.hi], [1, 4]);  // exact-boundary ties all claimed
    advanceTWindow(_noteMeshT, entries, 1.001, 5, win, (lo, hi) => hidden.push([lo, hi]));
    assert.deepEqual(hidden, [[1, 4]]);          // all three leave together, never split
});

test('advanceTWindow: the marker keyOf reads entry.t; empty arrays collapse', () => {
    const { advanceTWindow, _markerT } = load();
    const entries = [{ sprite: {}, t: 5 }, { sprite: {}, t: 7 }];
    const win = { lo: -1, hi: -1 };
    advanceTWindow(_markerT, entries, 4, 6, win,
        () => { throw new Error('a fresh window must not hide'); });
    assert.deepEqual([win.lo, win.hi], [0, 1]);
    const empty = { lo: -1, hi: -1 };
    advanceTWindow(_markerT, [], 0, 1, empty, () => {
        throw new Error('an empty chart must not hide');
    });
    assert.deepEqual([empty.lo, empty.hi], [0, 0]);
});
