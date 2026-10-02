// Practice difficulty override (feedBack#136): one deterministic,
// time-scoped difficulty override per player context.
//
// Complements player-difficulty.v1 rather than duplicating it: that
// command drives the song-wide mastery slider, this one drives a
// transient section/practice window and never mutates the slider. The
// override is installed on the highway bound to the supplied player
// context, so split-screen panels each get their own.
(function () {
    'use strict';

    window.feedBack = window.feedBack || {};
    const capabilities = window.feedBack.capabilities;
    if (!capabilities || capabilities.version !== 1) return;
    if (window.feedBack.practiceDifficultyDomain && window.feedBack.practiceDifficultyDomain.version === 1) return;

    const DOMAIN = 'practice-difficulty';
    const OWNER_ID = 'core.practice-difficulty';
    const DIAG_SCHEMA = 'feedBack.practice_difficulty.diagnostics.v1';
    const STATE_SCHEMA = 'feedBack.practice_difficulty.state.v1';
    const OVERRIDE_SCHEMA = 'feedBack.practice_difficulty.override.v1';
    const PARTICIPANT_SCHEMA = 'feedBack.practice_difficulty.participant.v1';
    const MAX_LABEL = 80;
    // Mirrors player-identity's `fields`: exactly the dimensions its
    // getHighway() matches on, so two contexts that hash to the same key
    // are guaranteed to resolve to the same highway. session_id is
    // included for completeness even though it is constant per page.
    const CONTEXT_FIELDS = ['session_id', 'player_id', 'profile_id', 'profile_hash',
        'song_id', 'arrangement_id', 'instrument', 'role', 'skill'];

    // contextKey → { contextKey, contextRef, context, source, difficultyPct,
    //                startTime, endTime, phraseIndices, label, clamped,
    //                activatedAt, highwayRef }
    const overrides = new Map();
    // pluginId → { pluginId, label, registeredAt }
    const participants = new Map();
    const _hasWeakRef = typeof WeakRef === 'function';
    let lastOutcome = null;

    function _text(value) { return value == null ? '' : String(value); }

    function _number(value) {
        const n = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(n) ? n : null;
    }

    // FNV-1a, matching playback.js. Used so the public surface can expose a
    // stable per-context reference without ever shipping the raw identity
    // fields (song/profile/player ids) into events, snapshots or diagnostics.
    function _hash(value) {
        let h = 2166136261;
        for (let i = 0; i < value.length; i += 1) {
            h ^= value.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return (h >>> 0).toString(36);
    }

    function _contextKey(context) {
        return CONTEXT_FIELDS.map(field => `${field}=${_text(context[field])}`).join('|');
    }

    function _contextRef(contextKey) { return `context-${_hash(contextKey)}`; }

    // Registrant-supplied free text is a user-facing practice description
    // ("Verse 2 · slow"), so it is echoed back on the public snapshot the
    // way playback.js exports target titles — but paths, URLs and
    // credentials are stripped before it can ever be exported, and it
    // never reaches diagnostics.
    function _label(value) {
        return _text(value)
            .replace(/(?:\/Users\/|\/home\/|\/root\b\/?|[A-Za-z]:\\)[^\r\n\t"',;(){}\[\]<>|]*/g, '[path]')
            .replace(/https?:\/\/[^\s?#]+[^\s]*/gi, '[url]')
            .replace(/\b(token|secret|password|api[_-]?key)=([^\s&]+)/gi, '$1=[redacted]')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, MAX_LABEL);
    }

    function _handled(payload = {}) { return { outcome: 'handled', payload }; }
    function _denied(reason, payload = {}) { return { outcome: 'denied', reason, payload }; }
    function _noTarget(reason) { return { outcome: 'no-target', reason }; }

    function _done(result) {
        lastOutcome = result.outcome;
        _contributeDiagnostics();
        return result;
    }

    function _callerId(ctx = {}) {
        // Dispatch sets requester from the caller. A payload can never claim
        // another registrant's slot — identity comes from here only.
        return _text(ctx.requester || ctx.source || 'unknown') || 'unknown';
    }

    function _payload(ctx = {}) {
        return ctx.payload && typeof ctx.payload === 'object' ? ctx.payload : {};
    }

    function _publicOverride(record) {
        return {
            schema: OVERRIDE_SCHEMA,
            context_ref: record.contextRef,
            source: record.source,
            difficulty_pct: record.difficultyPct,
            start_time: record.startTime,
            end_time: record.endTime,
            phrase_indices: record.phraseIndices.slice(),
            label: record.label,
            clamped: record.clamped,
            activated_at: record.activatedAt,
        };
    }

    function _publicParticipant(record) {
        return {
            schema: PARTICIPANT_SCHEMA,
            participant_ref: record.pluginId,
            label: record.label,
            registered_at: record.registeredAt,
        };
    }

    function _snapshot(extra = {}) {
        return {
            schema: STATE_SCHEMA,
            available: true,
            // Sorted so repeated reads of an unchanged domain are
            // byte-stable (diagnostics diffing, Inspector re-renders).
            active_overrides: [...overrides.values()]
                .map(_publicOverride)
                .sort((a, b) => a.context_ref.localeCompare(b.context_ref)),
            participants: [...participants.values()]
                .map(_publicParticipant)
                .sort((a, b) => a.participant_ref.localeCompare(b.participant_ref)),
            ...extra,
        };
    }

    function _emit(name, detail) {
        try { capabilities.emitEvent(DOMAIN, name, detail || {}); }
        catch (_) { /* eventing must not break the host */ }
    }

    // Counts and one bounded outcome string only — no context refs, labels,
    // timestamps, or identity fields (docs/capability-review-preflight.md).
    function _diagnostics() {
        return {
            schema: DIAG_SCHEMA,
            available: true,
            active_overrides: overrides.size,
            participants: participants.size,
            last_outcome: lastOutcome,
        };
    }

    function _contributeDiagnostics() {
        const diagnostics = window.feedBack && window.feedBack.diagnostics;
        if (!diagnostics || typeof diagnostics.contribute !== 'function') return;
        try { diagnostics.contribute('practice-difficulty', _diagnostics()); }
        catch (_) { /* diagnostics must not break the host */ }
    }

    function _playerContexts() {
        const contexts = window.feedBack && window.feedBack.playerContexts;
        return contexts && contexts.version === 1 && typeof contexts.getHighway === 'function'
            ? contexts
            : null;
    }

    function _resolveHighway(context) {
        const contexts = _playerContexts();
        if (!contexts) return null;
        try { return contexts.getHighway(context) || null; }
        catch (_) { return null; }
    }

    function _capable(highway) {
        return !!(highway && typeof highway.setDifficultyOverride === 'function');
    }

    function _install(record, highway) {
        try {
            highway.setDifficultyOverride({
                startTime: record.startTime,
                endTime: record.endTime,
                fraction: record.difficultyPct / 100,
            });
        } catch (_) {
            // One broken surface must not take the whole slot with it.
            return false;
        }
        return true;
    }

    function _installedOn(record, highway) {
        // Weak identity test — the highway holds exactly ONE override
        // slot, so two contexts resolving to the same instance would
        // silently overwrite each other's window while both records
        // claimed to be live.
        let current;
        try { current = highway.getDifficultyOverride(); }
        catch (_) { return false; }
        return !!current
            && current.startTime === record.startTime
            && current.endTime === record.endTime
            && current.fraction === record.difficultyPct / 100;
    }

    // Is any OTHER live record already installed on this highway?
    function _highwayOwner(highway, exceptKey) {
        for (const record of overrides.values()) {
            if (record.contextKey === exceptKey) continue;
            const ref = record.highwayRef;
            if (ref == null) continue;
            const other = _hasWeakRef ? ref.deref() : ref;
            if (other && other === highway) return record;
        }
        return null;
    }

    function _uninstall(record) {
        // Detach from the highway we actually installed on, NOT from
        // whatever getHighway(record.context) resolves to now. By the
        // time a stale record is released the context is already gone or
        // replaced, so re-resolving would return null and leave the
        // override stranded on the live highway. Held weakly so a closed
        // split-screen panel can still be collected; the strong fallback
        // only applies in minimal/test environments without WeakRef.
        const ref = record.highwayRef;
        const highway = ref == null ? null : (_hasWeakRef ? ref.deref() : ref);
        if (!_capable(highway)) return;
        try { highway.setDifficultyOverride(null); }
        catch (_) { /* best-effort */ }
    }

    function _release(record, reason) {
        if (!overrides.delete(record.contextKey)) return false;
        _uninstall(record);
        _emit('override-cleared', {
            context_ref: record.contextRef,
            source: record.source,
            reason,
        });
        return true;
    }

    // Reconcile every live record against the highway it resolved to.
    // This is the single cleanup path for song replacement
    // (player-identity leaves the context on song:loading), arrangement
    // switches, and profile changes — none of which need this module to
    // know the specific lifecycle rule.
    //
    // It re-installs as well as releases: the highway drops its own
    // override slot on init()/reconnect() (its song is being rebuilt),
    // so a same-song rebind would otherwise leave a record that inspect
    // reports as active, that still blocks competitors, and that is no
    // longer in force. A record whose context no longer resolves at all
    // is released instead.
    function _reconcile(reason) {
        let released = 0;
        let reinstalled = 0;
        for (const record of [...overrides.values()]) {
            const highway = _resolveHighway(record.context);
            if (!_capable(highway)) {
                if (_release(record, reason)) released += 1;
                continue;
            }
            // One override slot per highway instance: refuse to install
            // over another live record's window.
            const owner = _highwayOwner(highway, record.contextKey);
            if (owner) {
                if (_release(record, 'highway-reused')) released += 1;
                continue;
            }
            if (!_installedOn(record, highway)) {
                if (_install(record, highway)) reinstalled += 1;
            }
        }
        if (released || reinstalled) _contributeDiagnostics();
        return released;
    }

    function _releaseParticipant(pluginId, reason) {
        if (!pluginId) return 0;
        let released = 0;
        for (const record of [...overrides.values()]) {
            if (record.source === pluginId && _release(record, reason)) released += 1;
        }
        if (participants.delete(pluginId)) _emit('participant-unregistered', { participant_ref: pluginId, reason });
        return released;
    }

    function _registerParticipant(ctx = {}) {
        const pluginId = _callerId(ctx);
        if (pluginId === OWNER_ID) {
            return _done(_denied('The capability owner cannot register as a registrant', _snapshot()));
        }
        const label = _label(_payload(ctx).label);
        const existing = participants.get(pluginId);
        if (!existing) {
            participants.set(pluginId, {
                pluginId,
                label,
                registeredAt: new Date().toISOString(),
            });
            try {
                capabilities.registerParticipant(pluginId, {
                    [DOMAIN]: {
                        roles: ['provider'],
                        operations: ['practice.difficulty'],
                        events: ['override-activated', 'override-cleared'],
                        mode: 'active',
                        compatibility: 'none',
                        safety: 'safe',
                        runtime: true,
                        description: 'Drives time-scoped practice difficulty overrides for its own player contexts.',
                        provider_policy: { providerIds: [pluginId] },
                    },
                });
            } catch (_) { /* Inspector visibility is best-effort */ }
            _emit('participant-registered', { participant_ref: pluginId, label });
        } else if (label && label !== existing.label) {
            existing.label = label;
        }
        return _done(_handled({ ..._snapshot(), participant_ref: pluginId }));
    }

    function _unregisterParticipant(ctx = {}) {
        const pluginId = _callerId(ctx);
        const released = _releaseParticipant(pluginId, 'participant-unregistered');
        // Mirror chart-transform: only drop the capability participant when
        // it holds no other role on this domain.
        if (typeof capabilities.inspect === 'function') {
            const live = capabilities.inspect(DOMAIN);
            const participant = ((live && live.participants) || [])
                .find(p => p.pluginId === pluginId);
            const roles = participant && Array.isArray(participant.roles) ? participant.roles : [];
            const providerOnly = roles.length <= 1 && roles[0] === 'provider';
            if (!participant || providerOnly) {
                try { capabilities.unregisterParticipant(pluginId, DOMAIN); }
                catch (_) { /* participant cleanup is best-effort */ }
            }
        }
        return _done(_handled({ ..._snapshot(), released, participant_ref: pluginId }));
    }

    function _phraseIndices(value) {
        if (!Array.isArray(value)) return [];
        const out = [];
        for (const entry of value.slice(0, 64)) {
            const index = _number(entry);
            if (index !== null) out.push(index);
        }
        return out;
    }

    function _activate(ctx = {}) {
        const payload = _payload(ctx);
        const context = payload.player_context && typeof payload.player_context === 'object'
            ? payload.player_context
            : null;
        if (!context) return _done(_noTarget('An override requires a player_context'));

        const source = _callerId(ctx);
        const contextKey = _contextKey(context);

        // Conflict policy: incumbent wins. The registrant that first held
        // the slot keeps it until it clears, unregisters, or its context /
        // song goes away. A second registrant is refused rather than
        // stacked or silently allowed to steal the slot.
        const incumbent = overrides.get(contextKey);
        if (incumbent && incumbent.source !== source) {
            _emit('override-rejected', {
                context_ref: incumbent.contextRef,
                held_by: incumbent.source,
                rejected: source,
                reason: 'conflict',
            });
            return _done(_denied(
                `Player context is already overridden by ${incumbent.source}`,
                { ..._snapshot(), held_by: incumbent.source },
            ));
        }

        const requestedPct = _number(payload.difficulty_pct);
        if (requestedPct === null) {
            return _done(_denied('An override requires a finite numeric difficulty_pct'));
        }
        const difficultyPct = Math.max(0, Math.min(100, requestedPct));
        const startTime = _number(payload.start_time);
        const endTime = _number(payload.end_time);
        if (startTime === null || endTime === null) {
            return _done(_denied('An override requires finite start_time and end_time'));
        }
        // Half-open [start_time, end_time). A zero-length or inverted
        // window would never cover a phrase start and would silently do
        // nothing, so refuse it rather than record a no-op.
        if (endTime <= startTime) {
            return _done(_denied('An override requires end_time greater than start_time'));
        }
        // Same gate the sibling player-difficulty.v1 command applies: a
        // vocal context has no notes to make harder or easier, so an
        // override there could only be a mis-routed request.
        if (_text(context.role) === 'karaoke') {
            return _done(_denied('Practice difficulty overrides do not apply to a vocal player context'));
        }

        const highway = _resolveHighway(context);
        if (!_capable(highway)) {
            // Never record state we could not install — a consumer that
            // retries on the next context event then gets a clean attempt
            // instead of a slot it believes is live.
            return _done(_noTarget('No current player context matches this override'));
        }
        // The highway carries ONE override slot. Two different contexts
        // that resolve to the same instance (a rebind that kept the
        // context fields but swapped the panel's highway, a host that
        // reused an instance) would otherwise silently overwrite each
        // other while both records stayed live — the loser's window
        // would be gone but it would still block competitors and report
        // itself as in force via inspect.
        const owner = _highwayOwner(highway, contextKey);
        if (owner) {
            return _done(_denied(
                `Highway for this player context already carries ${owner.contextRef}`,
                { ..._snapshot(), held_by: owner.source },
            ));
        }

        const record = {
            contextKey,
            contextRef: _contextRef(contextKey),
            context: { ...context },
            source,
            difficultyPct,
            startTime,
            endTime,
            phraseIndices: _phraseIndices(payload.phrase_indices),
            label: _label(payload.label),
            clamped: difficultyPct !== requestedPct,
            activatedAt: new Date().toISOString(),
            highwayRef: _hasWeakRef ? new WeakRef(highway) : highway,
        };
        if (!_install(record, highway)) {
            return _done(_noTarget('Player highway rejected the override'));
        }
        overrides.set(contextKey, record);
        _emit('override-activated', _publicOverride(record));
        return _done(_handled({ ..._snapshot(), override: _publicOverride(record) }));
    }

    function _clear(ctx = {}) {
        const payload = _payload(ctx);
        const source = _callerId(ctx);
        const context = payload.player_context && typeof payload.player_context === 'object'
            ? payload.player_context
            : null;

        // Omitting player_context releases every slot the caller holds — the
        // right call in a teardown path, where the captured context may
        // already be stale (an arrangement switch or a new song changes
        // its key). Supplying one only narrows the release.
        if (!context) {
            // No context → release every slot this registrant holds. A
            // registrant never clears another registrant's override.
            let released = 0;
            for (const record of [...overrides.values()]) {
                if (record.source === source && _release(record, 'command-clear')) released += 1;
            }
            return _done(_handled({ ..._snapshot(), released }));
        }

        const contextKey = _contextKey(context);
        const incumbent = overrides.get(contextKey);
        // A snapshot captured before an arrangement switch or a new song
        // matches nothing, so the naive answer would be a silent
        // `released: false` with the real override still installed. Say
        // `no-target` instead so a consumer can fall back to the
        // context-less clear above.
        if (!incumbent) return _done(_noTarget('No active override for this player context'));
        if (incumbent.source !== source) {
            return _done(_denied(
                `Player context is overridden by ${incumbent.source}`,
                { ..._snapshot(), held_by: incumbent.source },
            ));
        }
        _release(incumbent, 'command-clear');
        return _done(_handled({ ..._snapshot(), released: true }));
    }

    capabilities.registerOwner(DOMAIN, {
        pluginId: OWNER_ID,
        kind: 'provider-coordinator',
        safety: 'safe',
        commands: ['inspect', 'register-participant', 'unregister-participant', 'activate', 'clear'],
        operations: ['practice.difficulty'],
        events: ['participant-registered', 'participant-unregistered', 'override-activated', 'override-cleared', 'override-rejected'],
        description: 'Owns one time-scoped practice difficulty override per player context, applied per highway without touching the song-wide mastery value.',
        handlers: {
            inspect: () => _done(_handled(_snapshot())),
            'register-participant': (ctx) => _registerParticipant(ctx),
            'unregister-participant': (ctx) => _unregisterParticipant(ctx),
            activate: (ctx) => _activate(ctx),
            clear: (ctx) => _clear(ctx),
        },
    });

    // Runtime participant disappearance (plugin disabled, screen torn down)
    // must release state — not just explicit unregister-participant.
    if (typeof capabilities.subscribe === 'function') {
        try {
            capabilities.subscribe('unregistered', (detail) => {
                const info = detail || {};
                if (info.capability !== DOMAIN || !info.pluginId) return;
                if (_releaseParticipant(_text(info.pluginId), 'participant-unregistered')) {
                    _contributeDiagnostics();
                }
            });
        } catch (_) { /* runtime cleanup is best-effort */ }
    }

    const bus = window.feedBack;
    if (typeof bus.on === 'function') {
        try {
            // Context lifecycle: left / changed / ready all cover song
            // replacement (player-identity leaves the context on
            // song:loading), arrangement switches and profile refreshes.
            for (const event of ['player-context:left', 'player-context:changed', 'player-context:ready']) {
                bus.on(event, () => _reconcile('context-replaced'));
            }
            bus.on('song:loading', () => _reconcile('song-replaced'));
            bus.on('song:loaded', () => _reconcile('song-replaced'));
        } catch (_) { /* bus mirroring is best-effort */ }
    }

    window.feedBack.practiceDifficultyDomain = {
        version: 1,
        snapshot: _snapshot,
        diagnostics: _diagnostics,
    };
    _contributeDiagnostics();
})();
