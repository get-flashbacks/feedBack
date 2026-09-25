const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWindow } = require('./capabilities_test_harness');

// The JS suite always runs from the repository root (package.json:test:js),
// so keep these source fixtures literal rather than constructing paths from
// external input.
const CAPABILITIES = fs.readFileSync('static/capabilities.js', 'utf8');
const SOURCE = fs.readFileSync('static/capabilities/player-identity.js', 'utf8');

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
