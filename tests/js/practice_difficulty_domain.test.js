// feedBack#136 — practice-difficulty capability domain.
//
// Runs the real capabilities.js runtime + the real domain module in a vm
// window, the same way player_identity_capability.test.js does, so these
// exercise dispatch attribution, participant lifecycle and the private
// player-context → highway routing rather than a hand-rolled double.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWindow, ROOT } = require('./capabilities_test_harness');

const CAPABILITIES = fs.readFileSync(path.join(ROOT, 'static', 'capabilities.js'), 'utf8');
const PLAYER_IDENTITY = fs.readFileSync(path.join(ROOT, 'static', 'capabilities', 'player-identity.js'), 'utf8');
const SOURCE = fs.readFileSync(path.join(ROOT, 'static', 'capabilities', 'practice-difficulty.js'), 'utf8');

// Values produced inside the vm carry that realm's Array/Object prototypes,
// which node:assert/strict's deepStrictEqual rejects even when the contents
// match. Normalize every cross-realm value through JSON on the way out.
function plain(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

// A highway double that records what it was handed. `setMastery` records
// separately so a test can prove the domain never touches the song-wide
// slider value (the real assertion about mastery lives in
// highway_difficulty_override.test.js).
function fakeHighway() {
    return {
        override: 'untouched',
        masteryCalls: [],
        setMastery(value) { this.masteryCalls.push(value); },
        setDifficultyOverride(value) { this.override = value === null ? null : plain(value); },
        // Mirrors the real highway's read-back, which is how the domain
        // notices a chart rebuild that dropped the slot behind its back.
        getDifficultyOverride() {
            return this.override === 'untouched' ? null : this.override;
        },
    };
}

function load() {
    const window = createWindow();
    const context = vm.createContext(window);
    vm.runInContext(CAPABILITIES, context, { filename: 'capabilities.js' });
    vm.runInContext(PLAYER_IDENTITY, context, { filename: 'player-identity.js' });
    vm.runInContext(SOURCE, context, { filename: 'practice-difficulty.js' });
    return window;
}

function makeContext(window, overrides = {}, highway) {
    return window.feedBack.playerContexts.upsert({
        player_id: 'player-1',
        profile_id: 'alex',
        profile_hash: 'hash-alex',
        song_id: 'song.feedpak',
        arrangement_id: 'lead',
        instrument: 'guitar',
        role: 'lead',
        skill: 'overall',
        ...overrides,
    }, highway, 'plugin.splitscreen');
}

function dispatch(window, command, source, args = {}) {
    return window.feedBack.capabilities.dispatch({
        capability: 'practice-difficulty', command, source, args,
    }).then(plain);
}

test('a domain snapshot is available and reports no overrides before any are activated', async () => {
    const window = load();
    const result = await dispatch(window, 'inspect', 'plugin.spectator');
    assert.equal(result.outcome, 'handled');
    assert.equal(result.payload.schema, 'feedBack.practice_difficulty.state.v1');
    assert.deepEqual(result.payload.active_overrides, []);
    assert.deepEqual(result.payload.participants, []);
});

test('activate installs one clamped override on the bound highway and leaves mastery alone', async () => {
    const window = load();
    const highway = fakeHighway();
    const context = makeContext(window, {}, highway);

    const result = await dispatch(window, 'activate', 'plugin.section_practice', {
        player_context: context,
        difficulty_pct: 140,
        start_time: 12.5,
        end_time: 24,
        phrase_indices: [3, 'x', -1],
        label: '  Verse   two  ',
    });

    assert.equal(result.outcome, 'handled');
    const override = result.payload.override;
    assert.equal(override.schema, 'feedBack.practice_difficulty.override.v1');
    assert.equal(override.difficulty_pct, 100, '140% clamps to 100%');
    assert.equal(override.clamped, true);
    assert.equal(override.start_time, 12.5);
    assert.equal(override.end_time, 24);
    assert.deepEqual(override.phrase_indices, [3, -1], 'non-numeric entries are dropped');
    assert.equal(override.label, 'Verse two');
    assert.equal(override.source, 'plugin.section_practice', 'attribution comes from the dispatch caller');

    assert.deepEqual(highway.override, { startTime: 12.5, endTime: 24, fraction: 1 },
        'the highway receives a 0..1 fraction, not a percentage');
    assert.deepEqual(highway.masteryCalls, [], 'the domain must never mutate the song-wide mastery slider');
});

test('difficulty_pct clamps low and reports when no clamping was needed', async () => {
    const window = load();
    const context = makeContext(window, {}, fakeHighway());

    const low = await dispatch(window, 'activate', 'plugin.section_practice', {
        player_context: context, difficulty_pct: -25, start_time: 0, end_time: 5,
    });
    assert.equal(low.payload.override.difficulty_pct, 0);
    assert.equal(low.payload.override.clamped, true);

    const exact = await dispatch(window, 'activate', 'plugin.section_practice', {
        player_context: context, difficulty_pct: 62.5, start_time: 0, end_time: 5,
    });
    assert.equal(exact.payload.override.difficulty_pct, 62.5);
    assert.equal(exact.payload.override.clamped, false);
});

test('one active override per player context: a second registrant is refused and the incumbent keeps the slot', async () => {
    const window = load();
    const highway = fakeHighway();
    const context = makeContext(window, {}, highway);
    const rejected = [];
    window.feedBack.on('capability:event', (event) => {
        const detail = event.detail || {};
        if (detail.capability === 'practice-difficulty' && detail.event === 'override-rejected') {
            rejected.push(detail.payload);
        }
    });

    await dispatch(window, 'register-participant', 'plugin.section_practice');
    const first = await dispatch(window, 'activate', 'plugin.section_practice', {
        player_context: context, difficulty_pct: 40, start_time: 12.5, end_time: 24,
    });
    assert.equal(first.outcome, 'handled');

    await dispatch(window, 'register-participant', 'plugin.step_mode');
    const second = await dispatch(window, 'activate', 'plugin.step_mode', {
        player_context: context, difficulty_pct: 10, start_time: 12.5, end_time: 24,
    });
    assert.equal(second.outcome, 'denied');
    assert.equal(second.payload.held_by, 'plugin.section_practice',
        'the conflict names the incumbent deterministically');
    assert.deepEqual(highway.override, { startTime: 12.5, endTime: 24, fraction: 0.4 },
        'the refused request must not touch the highway');

    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].held_by, 'plugin.section_practice');
    assert.equal(rejected[0].rejected, 'plugin.step_mode');

    const snapshot = await dispatch(window, 'inspect', 'plugin.spectator');
    assert.equal(snapshot.payload.active_overrides.length, 1, 'overrides never stack');
});

test('the same registrant re-activating updates its own override in place', async () => {
    const window = load();
    const highway = fakeHighway();
    const context = makeContext(window, {}, highway);

    await dispatch(window, 'activate', 'plugin.section_practice', {
        player_context: context, difficulty_pct: 40, start_time: 12.5, end_time: 24,
    });
    const again = await dispatch(window, 'activate', 'plugin.section_practice', {
        player_context: context, difficulty_pct: 55, start_time: 13, end_time: 26,
    });

    assert.equal(again.outcome, 'handled', 'self-update is not a conflict');
    assert.equal(again.payload.override.difficulty_pct, 55);
    const snapshot = await dispatch(window, 'inspect', 'plugin.spectator');
    assert.equal(snapshot.payload.active_overrides.length, 1);
    assert.deepEqual(highway.override, { startTime: 13, endTime: 26, fraction: 0.55 });
});

test('two different player contexts hold independent overrides', async () => {
    const window = load();
    const first = fakeHighway();
    const second = fakeHighway();
    const contextA = makeContext(window, { player_id: 'player-a' }, first);
    const contextB = makeContext(window, { player_id: 'player-b' }, second);

    const a = await dispatch(window, 'activate', 'plugin.section_practice', {
        player_context: contextA, difficulty_pct: 30, start_time: 0, end_time: 10,
    });
    const b = await dispatch(window, 'activate', 'plugin.step_mode', {
        player_context: contextB, difficulty_pct: 70, start_time: 0, end_time: 10,
    });

    assert.equal(a.outcome, 'handled');
    assert.equal(b.outcome, 'handled');
    assert.notEqual(a.payload.override.context_ref, b.payload.override.context_ref);
    assert.deepEqual(first.override, { startTime: 0, endTime: 10, fraction: 0.3 });
    assert.deepEqual(second.override, { startTime: 0, endTime: 10, fraction: 0.7 });

    const snapshot = await dispatch(window, 'inspect', 'plugin.spectator');
    assert.equal(snapshot.payload.active_overrides.length, 2);
});

test('a second context resolving to the same highway is refused, not silently merged', async () => {
    // The highway carries ONE override slot. Two contexts bound to the same
    // panel instance would otherwise overwrite each other's window while
    // both records claimed to be in force — the loser's record would still
    // block competitors and inspect would report it as active.
    const window = load();
    const shared = fakeHighway();
    const contextA = makeContext(window, { player_id: 'player-a' }, shared);
    const contextB = makeContext(window, { player_id: 'player-b' }, shared);

    await dispatch(window, 'activate', 'plugin.section_practice', {
        player_context: contextA, difficulty_pct: 30, start_time: 0, end_time: 10,
    });
    const clash = await dispatch(window, 'activate', 'plugin.step_mode', {
        player_context: contextB, difficulty_pct: 70, start_time: 0, end_time: 10,
    });

    assert.equal(clash.outcome, 'denied');
    assert.equal(clash.payload.held_by, 'plugin.section_practice');
    assert.deepEqual(shared.override, { startTime: 0, endTime: 10, fraction: 0.3 },
        'the first window stays in force on the shared highway');

    const snapshot = await dispatch(window, 'inspect', 'plugin.spectator');
    assert.equal(snapshot.payload.active_overrides.length, 1);
});

test('a record whose highway was rebuilt mid-song is re-installed, not left stranded', async () => {
    // highway.init()/reconnect() null their own override slot because the
    // chart is being rebuilt. If the domain only checked "does this context
    // still resolve?", the record would survive as live-but-uninstalled:
    // inspect would report it active and it would still block competitors
    // while the chart rendered at the slider.
    const window = load();
    const highway = fakeHighway();
    const context = makeContext(window, {}, highway);
    await dispatch(window, 'activate', 'plugin.section_practice', {
        player_context: context, difficulty_pct: 40, start_time: 12.5, end_time: 24,
    });

    // The panel rebuilds its highway against the same context.
    highway.override = null;
    window.feedBack.emit('player-context:changed', { detail: {} });

    assert.deepEqual(highway.override, { startTime: 12.5, endTime: 24, fraction: 0.4 },
        'the override is put back on the highway that still owns the context');
    const snapshot = await dispatch(window, 'inspect', 'plugin.spectator');
    assert.equal(snapshot.payload.active_overrides.length, 1);
});

test('a vocal player context is denied, matching the sibling player-difficulty.v1 gate', async () => {
    const window = load();
    const highway = fakeHighway();
    const context = makeContext(window, { role: 'karaoke', skill: 'vocal' }, highway);

    const result = await dispatch(window, 'activate', 'plugin.section_practice', {
        player_context: context, difficulty_pct: 40, start_time: 0, end_time: 10,
    });
    assert.equal(result.outcome, 'denied');
    assert.equal(highway.override, 'untouched');
    const snapshot = await dispatch(window, 'inspect', 'plugin.spectator');
    assert.deepEqual(snapshot.payload.active_overrides, []);
});

test('invalid ranges and non-finite difficulty are denied without touching the highway', async () => {
    const window = load();
    const highway = fakeHighway();
    const context = makeContext(window, {}, highway);
    const base = { player_context: context, difficulty_pct: 50 };

    const empty = await dispatch(window, 'activate', 'plugin.section_practice', {
        ...base, start_time: 10, end_time: 10,
    });
    assert.equal(empty.outcome, 'denied', 'a zero-length window is refused, not recorded as a no-op');

    const inverted = await dispatch(window, 'activate', 'plugin.section_practice', {
        ...base, start_time: 30, end_time: 20,
    });
    assert.equal(inverted.outcome, 'denied');

    const nan = await dispatch(window, 'activate', 'plugin.section_practice', {
        ...base, difficulty_pct: Number.NaN, start_time: 0, end_time: 10,
    });
    assert.equal(nan.outcome, 'denied', 'a non-finite difficulty has nothing sensible to clamp to');

    const missingTimes = await dispatch(window, 'activate', 'plugin.section_practice', {
        player_context: context, difficulty_pct: 50,
    });
    assert.equal(missingTimes.outcome, 'denied');

    assert.equal(highway.override, 'untouched', 'no rejected request may reach the highway');
    const snapshot = await dispatch(window, 'inspect', 'plugin.spectator');
    assert.deepEqual(snapshot.payload.active_overrides, [], 'a denied request records no state');
});

test('an override against a stale player context returns no-target and records nothing', async () => {
    const window = load();
    const highway = fakeHighway();
    const context = makeContext(window, {}, highway);

    // The arrangement changed underneath us — the captured snapshot no
    // longer matches any current context.
    window.feedBack.playerContexts.updateActive('player-1', { arrangement_id: 'rhythm' });

    const result = await dispatch(window, 'activate', 'plugin.section_practice', {
        player_context: context, difficulty_pct: 50, start_time: 0, end_time: 10,
    });
    assert.equal(result.outcome, 'no-target');
    assert.equal(highway.override, 'untouched');
    const snapshot = await dispatch(window, 'inspect', 'plugin.spectator');
    assert.deepEqual(snapshot.payload.active_overrides, []);
});

test('clear releases the calling registrant override; it cannot clear another registrant slot', async () => {
    const window = load();
    const highway = fakeHighway();
    const context = makeContext(window, {}, highway);
    await dispatch(window, 'activate', 'plugin.section_practice', {
        player_context: context, difficulty_pct: 40, start_time: 12.5, end_time: 24,
    });

    const foreign = await dispatch(window, 'clear', 'plugin.step_mode', { player_context: context });
    assert.equal(foreign.outcome, 'denied');
    assert.equal(foreign.payload.held_by, 'plugin.section_practice');
    assert.notEqual(highway.override, null, 'a refused clear must leave the override installed');

    const mine = await dispatch(window, 'clear', 'plugin.section_practice', { player_context: context });
    assert.equal(mine.outcome, 'handled');
    assert.equal(mine.payload.released, true);
    assert.equal(highway.override, null);

    // Clearing an already-released slot reports no-target rather than a
    // misleading `released: false`, so a consumer can tell "nothing to do"
    // apart from "I cleared something".
    const again = await dispatch(window, 'clear', 'plugin.section_practice', { player_context: context });
    assert.equal(again.outcome, 'no-target');
});

test('clear with a stale player_context reports no-target instead of a fake release', async () => {
    const window = load();
    const highway = fakeHighway();
    const context = makeContext(window, {}, highway);
    await dispatch(window, 'activate', 'plugin.section_practice', {
        player_context: context, difficulty_pct: 40, start_time: 12.5, end_time: 24,
    });

    // The consumer's captured snapshot goes stale (arrangement switch).
    // Core's lifecycle reconciliation already released the slot, so the
    // context-scoped clear matches nothing — and must say so rather than
    // report a `handled released: false` that reads like "still there,
    // nothing to do" or, worse, like it is still in force.
    window.feedBack.playerContexts.updateActive('player-1', { arrangement_id: 'rhythm' });
    assert.equal(highway.override, null, 'core already released it on the context change');

    const stale = await dispatch(window, 'clear', 'plugin.section_practice', { player_context: context });
    assert.equal(stale.outcome, 'no-target');
    assert.equal(stale.payload, undefined, 'no-target carries no handled snapshot');
    assert.equal(stale.reason, 'No active override for this player context');
});

test('clear without a player_context releases every override the caller owns', async () => {
    const window = load();
    const highwayA = fakeHighway();
    const highwayB = fakeHighway();
    const highwayC = fakeHighway();
    const contextA = makeContext(window, { player_id: 'player-a' }, highwayA);
    const contextB = makeContext(window, { player_id: 'player-b' }, highwayB);
    const contextC = makeContext(window, { player_id: 'player-c' }, highwayC);
    await dispatch(window, 'activate', 'plugin.section_practice', {
        player_context: contextA, difficulty_pct: 30, start_time: 0, end_time: 10,
    });
    await dispatch(window, 'activate', 'plugin.section_practice', {
        player_context: contextB, difficulty_pct: 70, start_time: 0, end_time: 10,
    });
    // A third context, because one override per context means two
    // registrants need two contexts to both hold a slot.
    await dispatch(window, 'activate', 'plugin.step_mode', {
        player_context: contextC, difficulty_pct: 10, start_time: 20, end_time: 30,
    });

    const result = await dispatch(window, 'clear', 'plugin.section_practice');
    assert.equal(result.outcome, 'handled');
    assert.equal(result.payload.released, 2);
    assert.equal(highwayA.override, null);
    assert.equal(highwayB.override, null);
    assert.deepEqual(highwayC.override, { startTime: 20, endTime: 30, fraction: 0.1 },
        'another registrant keeps its own slot');
});

test('unregister-participant releases that registrant state and participant record', async () => {
    const window = load();
    const highway = fakeHighway();
    const context = makeContext(window, {}, highway);
    await dispatch(window, 'register-participant', 'plugin.section_practice', { label: 'Section Practice' });
    await dispatch(window, 'activate', 'plugin.section_practice', {
        player_context: context, difficulty_pct: 40, start_time: 0, end_time: 10,
    });

    const result = await dispatch(window, 'unregister-participant', 'plugin.section_practice');
    assert.equal(result.outcome, 'handled');
    assert.equal(result.payload.released, 1);
    assert.equal(highway.override, null);
    assert.deepEqual(result.payload.active_overrides, []);
    assert.deepEqual(result.payload.participants, []);
});

test('runtime participant disappearance releases state without an explicit unregister', async () => {
    const window = load();
    const highway = fakeHighway();
    const context = makeContext(window, {}, highway);
    await dispatch(window, 'register-participant', 'plugin.section_practice');
    await dispatch(window, 'activate', 'plugin.section_practice', {
        player_context: context, difficulty_pct: 40, start_time: 0, end_time: 10,
    });
    assert.notEqual(highway.override, null);

    // The host tears the plugin down at runtime.
    window.feedBack.capabilities.unregisterParticipant('plugin.section_practice', 'practice-difficulty');

    const snapshot = await dispatch(window, 'inspect', 'plugin.spectator');
    assert.deepEqual(snapshot.payload.active_overrides, [], 'runtime disappearance must not leak a stuck override');
    assert.deepEqual(snapshot.payload.participants, []);
    assert.equal(highway.override, null, 'the highway is told to clear, not left holding the override');
});

test('a replaced player context clears the override that referred to the old one', async () => {
    const window = load();
    const highway = fakeHighway();
    const context = makeContext(window, {}, highway);
    await dispatch(window, 'activate', 'plugin.section_practice', {
        player_context: context, difficulty_pct: 40, start_time: 0, end_time: 10,
    });

    // Arrangement switch: player-identity republishes the context, which
    // changes its key, so the captured override no longer resolves.
    window.feedBack.playerContexts.updateActive('player-1', { arrangement_id: 'rhythm' });

    const snapshot = await dispatch(window, 'inspect', 'plugin.spectator');
    assert.deepEqual(snapshot.payload.active_overrides, []);
    assert.equal(highway.override, null);
});

test('a departing player context clears the override on song replacement', async () => {
    const window = load();
    const highway = fakeHighway();
    const context = makeContext(window, {}, highway);
    await dispatch(window, 'activate', 'plugin.section_practice', {
        player_context: context, difficulty_pct: 40, start_time: 0, end_time: 10,
    });

    window.feedBack.playerContexts.leave('player-1', 'plugin.splitscreen');

    const snapshot = await dispatch(window, 'inspect', 'plugin.spectator');
    assert.deepEqual(snapshot.payload.active_overrides, []);
    assert.equal(highway.override, null);
});

test('requests against a Host without this domain degrade to a no-op outcome', async () => {
    const window = load();
    // No practice-difficulty module evaluated — the shape an older Host has.
    const bare = createWindow();
    const context = vm.createContext(bare);
    vm.runInContext(CAPABILITIES, context, { filename: 'capabilities.js' });
    vm.runInContext(PLAYER_IDENTITY, context, { filename: 'player-identity.js' });

    const result = await bare.feedBack.capabilities.dispatch({
        capability: 'practice-difficulty', command: 'activate', source: 'plugin.section_practice',
        args: { player_context: { player_id: 'player-1' }, difficulty_pct: 40, start_time: 0, end_time: 10 },
    });
    assert.notEqual(result.outcome, 'handled');
    assert.equal(typeof result.outcome, 'string');
    assert.equal(window.feedBack.practiceDifficultyDomain.version, 1);
});

test('override snapshots and diagnostics never carry raw song/profile/player identity', async () => {
    const window = load();
    const highway = fakeHighway();
    const context = makeContext(window, {}, highway);
    await dispatch(window, 'activate', 'plugin.section_practice', {
        player_context: context, difficulty_pct: 40, start_time: 0, end_time: 10,
        label: 'private label',
    });

    const secrets = ['song.feedpak', 'hash-alex', 'player-1', 'profile_id'];
    const snapshot = await dispatch(window, 'inspect', 'plugin.spectator');
    const serializedSnapshot = JSON.stringify(snapshot.payload);
    for (const secret of secrets) {
        assert.equal(serializedSnapshot.includes(secret), false, `snapshot leaked ${secret}`);
    }
    assert.match(snapshot.payload.active_overrides[0].context_ref, /^context-[a-z0-9]+$/);
    // The label is a bounded, user-facing practice description (the same
    // shape playback.js exports for target titles) so it IS part of the
    // public snapshot — but it must never reach diagnostics.
    assert.equal(snapshot.payload.active_overrides[0].label, 'private label');

    const diagnostics = window.feedBack.diagnostics.snapshotContributions()['practice-difficulty'];
    assert.deepEqual({ ...diagnostics }, {
        schema: 'feedBack.practice_difficulty.diagnostics.v1',
        available: true,
        active_overrides: 1,
        participants: 0,
        last_outcome: 'handled',
    });
    const serializedDiagnostics = JSON.stringify(diagnostics);
    for (const secret of [...secrets, 'private label']) {
        assert.equal(serializedDiagnostics.includes(secret), false, `diagnostics leaked ${secret}`);
    }
});

test('registrant labels are redacted of control characters and bounded', async () => {
    const window = load();
    const result = await dispatch(window, 'register-participant', 'plugin.section_practice', {
        label: `line\nbreak\t${'x'.repeat(200)}`,
    });
    const participant = result.payload.participants[0];
    assert.equal(participant.participant_ref, 'plugin.section_practice');
    assert.equal(participant.label.includes('\n'), false);
    assert.equal(participant.label.length <= 80, true);
});

test('labels are stripped of filesystem paths, URLs and credentials', async () => {
    // Each pass is exercised on its own: the path pattern is deliberately
    // greedy (it matches playback.js's target-title redaction exactly), so
    // a path followed by a URL collapses to '[path]' in one go.
    const window = load();
    const context = makeContext(window, {}, fakeHighway());
    const cases = [
        ['C:\\Users\\alex\\chart.gp5', ['[path]'], ['alex', 'chart.gp5']],
        ['/home/alex/song.sloppak verse', ['[path]'], ['alex', 'song.sloppak']],
        ['https://example.com/a?b=c bridge', ['[url]'], ['example.com']],
        ['token=abc123 keep this', ['token=[redacted]'], ['abc123']],
    ];
    for (const [label, expected, forbidden] of cases) {
        const result = await dispatch(window, 'activate', 'plugin.section_practice', {
            player_context: context, difficulty_pct: 40, start_time: 0, end_time: 10, label,
        });
        for (const needle of expected) {
            assert.equal(result.payload.override.label.includes(needle), true,
                `${JSON.stringify(label)} should keep ${needle}`);
        }
        for (const needle of forbidden) {
            assert.equal(result.payload.override.label.includes(needle), false,
                `${JSON.stringify(label)} leaked ${needle}`);
        }
    }
});