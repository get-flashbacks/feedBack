// Local player identity is independent of panel DOM and rendering cadence.
(function () {
    'use strict';
    const fb = window.feedBack;
    const caps = fb && fb.capabilities;
    if (!caps || caps.version !== 1 || fb.playerContexts) return;
    const session = window.crypto?.randomUUID?.()
        || (window.crypto?.getRandomValues
            ? `local-${Date.now()}-${Array.from(window.crypto.getRandomValues(new Uint32Array(2)), b => b.toString(36)).join('')}`
            : `local-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const players = new Map();
    const fields = ['session_id', 'player_id', 'profile_id', 'profile_hash', 'song_id', 'arrangement_id', 'instrument', 'role', 'skill'];
    const text = value => value == null ? '' : String(value);
    function snapshot(entry) { return entry ? { ...entry.context } : null; }
    function inspect() {
        return { schema: 'feedBack.player_identity.diagnostics.v1', active: players.size,
            ready: [...players.values()].filter(e => e.context.ready).length };
    }
    function announce(event, entry) {
        if (typeof fb.emit === 'function') fb.emit(`player-context:${event}`, snapshot(entry));
        // Capability diagnostics never receive profile, song, session or player IDs.
        caps.emitEvent('player-identity', event, inspect());
        fb.diagnostics?.contribute('player-identity', inspect());
    }
    function profileIdentity(profile) {
        return { profile_id: text(profile?.profile_id ?? profile?.id ?? profile?.player_hash),
            profile_hash: text(profile?.profile_hash ?? profile?.player_hash),
            profile_ready: !!profile && profile.ready !== false && profile.profile_ready !== false };
    }
    function currentProfile() {
        try { return profileIdentity(window.v3Profile?.get()); }
        catch (_) { return profileIdentity(null); }
    }
    function contextOf(merged) {
        const context = { schema: 'difficulty_ladder.player_context.v1' };
        for (const field of fields) context[field] = text(merged[field]);
        context.session_id = session;
        context.skill ||= 'overall';
        context.role ||= 'instrumental';
        if (/^(karaoke|vocal|vocals|singer|harmony)$/i.test(context.role)) {
            context.role = 'karaoke'; context.instrument = 'voice';
        }
        context.profile_ready = merged.profile_ready !== false && !!(context.profile_id || context.profile_hash);
        context.ready = context.profile_ready && !!context.song_id && !!context.arrangement_id && !!context.instrument;
        return context;
    }

    function hasExplicitProfile(input) {
        return Object.hasOwn(input, 'profile_id') || Object.hasOwn(input, 'profile_hash');
    }

    function changed(old, entry) {
        if (!old) return true;
        if (old.highway !== entry.highway) return true;
        return JSON.stringify(old.context) !== JSON.stringify(entry.context);
    }

    function upsert(input, highway, source = 'core.player') {
        if (!input || !text(input.player_id) || (input.session_id && input.session_id !== session)) return null;
        const id = text(input.player_id);
        const old = players.get(id);
        if (old && old.source !== source) return null;
        const inherited = hasExplicitProfile(input) ? false : (old?.inherited ?? true);
        const merged = { ...old?.context, ...input, ...(inherited ? currentProfile() : {}) };
        const context = contextOf(merged);
        const entry = { context, inherited, source, highway: highway === undefined ? old?.highway : highway };
        players.set(id, entry);
        if (changed(old, entry)) {
            announce(context.ready && !old?.context.ready ? 'ready' : 'changed', entry);
        }
        return snapshot(entry);
    }
    function leave(id, source = 'core.player') {
        const entry = players.get(id);
        if (!entry || entry.source !== source) return false;
        players.delete(id);
        announce('left', entry);
        return true;
    }
    function refreshProfiles() {
        for (const [id, entry] of players) {
            if (entry.inherited) upsert({ player_id: id }, undefined, entry.source);
        }
    }
    function getHighway(context) {
        const entry = players.get(context?.player_id);
        return entry && fields.every(f => entry.context[f] === text(context[f])) ? entry.highway : null;
    }
    function updateActive(id, patch) {
        const entry = players.get(id);
        if (!entry || !patch || typeof patch !== 'object') return null;
        return upsert({ ...patch, player_id: id }, undefined, entry.source);
    }
    function difficulty(request) {
        const context = request?.player_context;
        const highway = getHighway(context);
        const entry = players.get(context?.player_id);
        const value = request?.current_difficulty;
        if (!entry?.context.ready || !highway?.setMastery) return { outcome: 'no-target' };
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100 || entry.context.role === 'karaoke') {
            return { outcome: 'denied', reason: 'Invalid instrumental difficulty request' };
        }
        highway.setMastery(value / 100);
        return { outcome: 'handled' };
    }
    caps.registerOwner('player-identity', {
        pluginId: 'core.player-identity', kind: 'command', safety: 'safe',
        commands: ['inspect'], events: ['ready', 'changed', 'left'],
        description: 'Owns local player identity and private highway bindings independently of panel layout.',
        handlers: { inspect: () => ({ outcome: 'handled', payload: inspect() }) },
    });
    caps.registerOwner('player-difficulty.v1', {
        pluginId: 'core.player-identity', kind: 'command', safety: 'safe', commands: ['set'],
        description: 'Routes difficulty to the highway matching every current player-context dimension.',
        handlers: { set: ctx => difficulty(ctx.payload) },
    });
    fb.playerContexts = Object.freeze({ version: 1, session_id: session, upsert, leave,
        getActive: (id = 'main') => snapshot(players.get(id)),
        list: () => [...players.values()].map(snapshot), getHighway, updateActive, refreshProfiles,
    });
    function resolveType(info, song) {
        const arrangement = info.arrangement || {};
        return text(info.arrangement_type
            || (typeof arrangement === 'object' ? (arrangement.type || arrangement.name || song.arrangement) : arrangement)
        ).toLowerCase();
    }
    function classifyInstrument(type) {
        if (/bass/.test(type)) return 'bass';
        if (/piano|keys|keyboard/.test(type)) return 'keys';
        if (/drum/.test(type)) return 'drums';
        if (/vocal|voice|karaoke/.test(type)) return 'voice';
        return 'guitar';
    }
    function classifyRole(instrument, type) {
        if (instrument === 'voice') return 'karaoke';
        if (/rhythm/.test(type)) return 'rhythm';
        if (/lead/.test(type)) return 'lead';
        return 'instrumental';
    }
    function mainSong() {
        const song = fb.currentSong;
        if (!song?.filename) return;
        const info = window.highway?.getSongInfo?.() || {};
        // fb.currentSong / song:loaded are broadcast globals every highway
        // instance overwrites+fires on its own song_info (highway.js) --
        // including split-screen panels, which is exactly the concurrent-play
        // case this capability exists to serve. window.highway itself always
        // stays bound to the main player, so its OWN getSongInfo() is
        // authoritative for arrangement/instrument (used below); but there is
        // no per-instance filename exposed to cross-check song_id against, so
        // reject a panel-fired event for a genuinely different song using the
        // title/artist window.highway actually reports (present once its own
        // song_info has arrived). A panel showing a different ARRANGEMENT of
        // the SAME song -- the normal multi-panel case -- still passes.
        if (info.title != null && text(info.title) !== text(song.title)) return;
        if (info.artist != null && text(info.artist) !== text(song.artist)) return;
        const type = resolveType(info, song);
        const instrument = classifyInstrument(type);
        upsert({ player_id: 'main', song_id: song.filename,
            arrangement_id: text(info.arrangement_index ?? song.arrangementIndex ?? 0), instrument,
            role: classifyRole(instrument, type),
        }, window.highway);
    }
    // A same-screen song switch stops the highway and emits song:loading well
    // before the next song:loaded; without this, a consumer holding the
    // previous ready snapshot could still getHighway()/apply difficulty to
    // the stopped-and-about-to-be-reused highway during that window (and
    // indefinitely, if the load fails). Drop the context now; mainSong()
    // republishes a fresh one on song:loaded.
    fb.on?.('song:loading', () => leave('main'));
    fb.on?.('song:loaded', mainSong);
    fb.on?.('profile:changed', refreshProfiles);
    fb.on?.('v3:profile-updated', refreshProfiles);
    fb.on?.('screen:changed', e => { if (e.detail?.id !== 'player') leave('main'); });
    mainSong();
})();
