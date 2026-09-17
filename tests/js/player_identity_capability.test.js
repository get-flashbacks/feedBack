const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWindow, ROOT } = require('./capabilities_test_harness');

const CAPABILITIES = fs.readFileSync(path.join(ROOT, 'static', 'capabilities.js'), 'utf8');
const SOURCE = fs.readFileSync(path.join(ROOT, 'static', 'capabilities', 'player-identity.js'), 'utf8');

function load(beforePlayerIdentity) {
    const window = createWindow();
    const context = vm.createContext(window);
    vm.runInContext(CAPABILITIES, context, { filename: 'capabilities.js' });
    if (beforePlayerIdentity) beforePlayerIdentity(window);
    vm.runInContext(SOURCE, context, { filename: 'player-identity.js' });
    return window;
}

test('inherited contexts stay pending until the v3 profile becomes ready', () => {
    let profile = null;
    const window = load(w => { w.v3Profile = { get: () => profile }; });
    const events = [];
    window.feedBack.on('player-context:ready', event => events.push(event.detail));
    const pending = window.feedBack.playerContexts.upsert({
        player_id: 'player-1', song_id: 'song.feedpak', arrangement_id: 'lead', instrument: 'guitar',
    }, {}, 'plugin.splitscreen');
    assert.equal(pending.ready, false);

    profile = { id: 'alex', player_hash: 'hash-alex' };
    window.feedBack.emit('profile:changed', { ready: true });
    assert.equal(window.feedBack.playerContexts.getActive('player-1').ready, true);
    assert.equal(events.length, 1);
    assert.equal(events[0].profile_hash, 'hash-alex');
});

test('player identity publishes ready contexts without exposing highway objects', () => {
    const window = load();
    const highway = { setMastery() {} };
    const events = [];
    window.feedBack.on('player-context:ready', event => events.push(event.detail));

    const context = window.feedBack.playerContexts.upsert({
        player_id: 'player-1', profile_id: 'alex', profile_hash: 'hash-alex',
        song_id: 'song.feedpak', arrangement_id: 'lead', instrument: 'guitar', role: 'lead',
    }, highway, 'plugin.splitscreen');

    assert.equal(context.ready, true);
    assert.equal(context.player_id, 'player-1');
    assert.equal(Object.hasOwn(context, 'highway'), false);
    assert.deepEqual(events, [context]);
    assert.equal(window.feedBack.playerContexts.getHighway(context), highway);
});

test('player difficulty requires the complete current identity and routes to one highway', async () => {
    const window = load();
    let mastery = null;
    const highway = { setMastery(value) { mastery = value; } };
    const context = window.feedBack.playerContexts.upsert({
        player_id: 'player-2', profile_id: 'alex', song_id: 'song.feedpak',
        arrangement_id: 'lead', instrument: 'guitar', role: 'lead',
    }, highway, 'plugin.splitscreen');

    const handled = await window.feedBack.capabilities.dispatch({
        capability: 'player-difficulty.v1', command: 'set', source: 'test',
        args: { player_context: context, current_difficulty: 64 },
    });
    assert.equal(handled.outcome, 'handled');
    assert.equal(mastery, 0.64);

    window.feedBack.playerContexts.updateActive('player-2', { arrangement_id: 'rhythm' });
    mastery = null;
    const stale = await window.feedBack.capabilities.dispatch({
        capability: 'player-difficulty.v1', command: 'set', source: 'test',
        args: { player_context: context, current_difficulty: 90 },
    });
    assert.equal(stale.outcome, 'no-target');
    assert.equal(mastery, null);
});

test('karaoke normalization and diagnostics stay identity-free', () => {
    const window = load();
    const context = window.feedBack.playerContexts.upsert({
        player_id: 'singer', profile_hash: 'secret-profile-hash', song_id: 'private-song.feedpak',
        arrangement_id: 'vocals', instrument: 'guitar', role: 'vocals', skill: 'vocal-pitch',
    }, {}, 'plugin.lyrics_karaoke');
    assert.equal(context.role, 'karaoke');
    assert.equal(context.instrument, 'voice');

    const diagnostic = window.feedBack.diagnostics.snapshotContributions()['player-identity'];
    assert.deepEqual({ ...diagnostic }, {
        schema: 'feedBack.player_identity.diagnostics.v1', active: 1, ready: 1,
    });
    assert.equal(JSON.stringify(diagnostic).includes('secret-profile-hash'), false);
    assert.equal(JSON.stringify(diagnostic).includes('private-song.feedpak'), false);
});

test('song:loading invalidates the main context so a difficulty request against it returns no-target', async () => {
    const window = load();
    let mastery = null;
    const highway = {
        setMastery(value) { mastery = value; },
        getSongInfo() { return { arrangement: 'Lead', arrangement_index: 0 }; },
    };
    window.highway = highway;
    window.v3Profile = { get: () => ({ id: 'alex', ready: true }) };
    window.feedBack.currentSong = { filename: 'song.feedpak', arrangement: 'Lead', arrangementIndex: 0 };
    window.feedBack.emit('song:loaded');

    const context = window.feedBack.playerContexts.getActive('main');
    assert.equal(context.ready, true, 'main context must be published and ready after song:loaded');

    // A same-screen song switch: song:loading fires well before the next
    // song:loaded (the highway may already be stopped/reused in that gap).
    window.feedBack.emit('song:loading');
    assert.equal(window.feedBack.playerContexts.getActive('main'), null,
        'the stale main context must be gone once song:loading fires');

    mastery = null;
    const stale = await window.feedBack.capabilities.dispatch({
        capability: 'player-difficulty.v1', command: 'set', source: 'test',
        args: { player_context: context, current_difficulty: 50 },
    });
    assert.equal(stale.outcome, 'no-target', 'a request against the invalidated context must not reach the highway');
    assert.equal(mastery, null, 'the (possibly reused) highway must not be touched');
});

test('mainSong() prefers getSongInfo().arrangement_type over the display-name arrangement string', () => {
    const window = load();
    const highway = { setMastery() {} };
    // 'arrangement' here is deliberately a generic display name that gives no
    // instrument hint on its own — only arrangement_type identifies it as bass.
    window.highway = highway;
    window.feedBack.currentSong = { filename: 'song.feedpak', arrangement: 'Player 1' };
    window.highway.getSongInfo = () => ({ arrangement: 'Player 1', arrangement_type: 'bass', arrangement_index: 2 });
    window.feedBack.emit('song:loaded');

    const context = window.feedBack.playerContexts.getActive('main');
    assert.equal(context.instrument, 'bass',
        'arrangement_type must be consulted, not just the display-name string');
});

test('a panel highway broadcasting song:loaded for a DIFFERENT song does not corrupt the main context', () => {
    // fb.currentSong / song:loaded are shared globals every highway instance
    // (main or a split-screen panel) overwrites and fires on its own
    // song_info (see static/highway.js) -- panels are exactly the
    // concurrent-play case this capability serves.
    const window = load();
    const highway = {
        setMastery() {},
        getSongInfo() { return { title: 'Main Song', artist: 'Main Artist', arrangement: 'Lead', arrangement_index: 0 }; },
    };
    window.highway = highway;
    window.v3Profile = { get: () => ({ id: 'alex', ready: true }) };
    window.feedBack.currentSong = { filename: 'main.feedpak', title: 'Main Song', artist: 'Main Artist', arrangement: 'Lead', arrangementIndex: 0 };
    window.feedBack.emit('song:loaded');
    const before = window.feedBack.playerContexts.getActive('main');
    assert.equal(before.arrangement_id, '0');

    // A split-screen panel loads an unrelated song and broadcasts on the
    // SAME shared globals -- window.highway (main's own instance) is
    // untouched, but fb.currentSong now reflects the panel.
    window.feedBack.currentSong = { filename: 'other-song.feedpak', title: 'Other Song', artist: 'Other Artist', arrangement: 'Bass', arrangementIndex: 3 };
    window.feedBack.emit('song:loaded');

    assert.deepEqual(window.feedBack.playerContexts.getActive('main'), before,
        'the main context must be untouched by a panel broadcasting a different song');
});

test('a panel highway broadcasting a DIFFERENT ARRANGEMENT of the SAME song still updates main (normal multi-panel case)', () => {
    const window = load();
    let arrangementIndex = 0;
    const highway = {
        setMastery() {},
        getSongInfo() { return { title: 'Shared Song', artist: 'Shared Artist', arrangement: 'Lead', arrangement_index: arrangementIndex }; },
    };
    window.highway = highway;
    window.v3Profile = { get: () => ({ id: 'alex', ready: true }) };
    window.feedBack.currentSong = { filename: 'song.feedpak', title: 'Shared Song', artist: 'Shared Artist', arrangement: 'Lead', arrangementIndex: 0 };
    window.feedBack.emit('song:loaded');
    assert.equal(window.feedBack.playerContexts.getActive('main').arrangement_id, '0');

    // Same song, main's own arrangement changed (simulating a legitimate
    // main-player arrangement switch, reflected in window.highway itself).
    arrangementIndex = 1;
    window.feedBack.currentSong = { filename: 'song.feedpak', title: 'Shared Song', artist: 'Shared Artist', arrangement: 'Rhythm', arrangementIndex: 1 };
    window.feedBack.emit('song:loaded');
    assert.equal(window.feedBack.playerContexts.getActive('main').arrangement_id, '1');
});
