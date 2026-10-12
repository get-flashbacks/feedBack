// Section Practice → practice-difficulty capability bridge (feedBack#140).
//
// Section Practice (static/js/section-practice.js) owns a looped section; this
// bridge turns that loop into a time-scoped `practice-difficulty` override
// (feedBack#136) whenever the user has pinned a manual practice difficulty for
// the section. The capability DOMAIN owns the actual highway write — this module
// never touches a highway or another plugin's state; it owns only the
// producer-side bookkeeping:
//
//   * which loop window the override belongs to (so repeated reconciles dedupe
//     instead of re-dispatching on every render),
//   * when to activate (only after Section Practice actually owns a live loop),
//   * and idempotent clearing — a loop ended by ANOTHER producer routes through
//     Section Practice's own teardown, and more than one teardown path can fire
//     for a single event, so only the first clear may dispatch.
//
// No imports on purpose. It resolves `window.feedBack.capabilities` and
// `window.feedBack.playerContexts` lazily at call time, so it works whether
// those land before or after this module, and the whole thing is exercisable in
// the Node vm harness with a hand-rolled dispatch double (see
// tests/js/section_practice_difficulty.test.js).

// Stable core source id for the capability dispatch. Plugins use a
// manifest-derived id; core's Section Practice has no manifest, so this is the
// fixed, documented identifier (the same shape as `core.practice-difficulty` /
// `core.player-identity`). It is the attribution the domain records, the value
// the `override-cleared` event echoes back, and the key `clear` releases by.
export const SECTION_PRACTICE_SOURCE = 'core.section-practice';

export function createSectionPracticeDifficulty(options = {}) {
    const win = options.window || (typeof window !== 'undefined' ? window : undefined);
    const warn = options.warn || ((...args) => {
        try { (win && win.console ? win.console : console).warn(...args); }
        catch (_) { /* logging must never break practice */ }
    });

    // `${start}|${end}|${pct}` of the override this producer currently holds, or
    // null when it holds none. Set only on a `handled` activate, because the
    // domain refuses to record state it could not install (no-target/denied) —
    // and drops it itself on song/context replacement.
    let activeKey = null;
    // Every activate/clear is serialized through this chain. Without it, a clear
    // that arrives while an activate is still in flight would find activeKey
    // null, no-op, and then the activate would resolve `handled` and leave an
    // override behind that the producer believes it released. Serializing makes
    // the clear run AFTER the activate, when the key is known.
    let tail = Promise.resolve();
    // The bus subscription is established lazily: this module is evaluated
    // BEFORE app.js's body assigns window.feedBack (the import graph runs
    // first), so subscribing at module-eval time would silently miss the bus.
    let subscribed = false;

    function enqueue(task) {
        const run = tail.then(task, task);
        tail = run.then(() => {}, () => {});
        return run;
    }

    function ensureSubscribed() {
        if (subscribed) return;
        const bus = win && win.feedBack;
        if (!bus || typeof bus.on !== 'function') return;
        try { bus.on('practice-difficulty:override-cleared', onOverrideCleared); }
        catch (_) { return; /* retry on the next capability call */ }
        subscribed = true;
    }

    function api() {
        ensureSubscribed();
        const caps = win && win.feedBack && win.feedBack.capabilities;
        return caps && typeof caps.dispatch === 'function' ? caps : null;
    }

    function playerContext() {
        const contexts = win && win.feedBack && win.feedBack.playerContexts;
        if (!contexts || typeof contexts.getActive !== 'function') return null;
        try { return contexts.getActive('main') || null; }
        catch (_) { return null; }
    }

    function keyFor(target) {
        return `${target.startTime}|${target.endTime}|${target.difficultyPct}`;
    }

    async function dispatch(command, payload) {
        const caps = api();
        if (!caps) return null;
        try {
            return await caps.dispatch({
                capability: 'practice-difficulty',
                command,
                source: SECTION_PRACTICE_SOURCE,
                payload,
            });
        } catch (err) {
            // A host without the domain, or a dispatch that throws, degrades to
            // "no override available" — practice keeps working at the slider.
            warn('[section-practice] practice-difficulty dispatch failed', err);
            return null;
        }
    }

    function supported() { return !!api(); }

    function isActive() { return activeKey !== null; }

    // Activate (or update in place) the override for `target`. Never records a
    // key the domain did not confirm as `handled`, so a stale context
    // (`no-target`) leaves the producer free to retry on the next reconcile.
    async function doActivate(target) {
        if (!target) return null;
        const context = playerContext();
        // No bound main-player context (player-identity has not published one,
        // or a song switch dropped it) — the domain would answer `no-target`
        // anyway, so don't even dispatch.
        if (!context) return null;

        // A vocal context has no notes to re-level — the domain denies it, so
        // skip the round-trip entirely rather than emit a rejected request on
        // every reconcile while a vocal section is looped.
        if (String(context.role || '').toLowerCase() === 'karaoke') return 'denied';

        const key = keyFor(target);
        // Same window + same percentage as what is already installed: the
        // domain updates in place, so re-dispatching would be pure churn on
        // every Section Practice re-render.
        if (key === activeKey) return 'handled';

        const result = await dispatch('activate', {
            player_context: context,
            difficulty_pct: target.difficultyPct,
            start_time: target.startTime,
            end_time: target.endTime,
            phrase_indices: Array.isArray(target.phraseIndices) ? target.phraseIndices : [],
            label: target.label,
        });
        const outcome = result && result.outcome ? result.outcome : null;
        if (outcome === 'handled') activeKey = key;
        return outcome;
    }

    // Release the override this producer holds, at most once. Nulling the key
    // BEFORE the await is what makes it idempotent under the several teardown
    // funnels that can fire for one event (mode toggle, clearLoop, song change).
    async function doClear(reason) {
        if (activeKey === null) return false;
        activeKey = null;
        await dispatch('clear', { reason: reason || 'section-practice-teardown' });
        return true;
    }

    function activate(target) { return enqueue(() => doActivate(target)); }

    function clear(reason) { return enqueue(() => doClear(reason)); }

    // The single producer entry point: hand it the override the current loop
    // SHOULD have (or null) and it reconciles. Section Practice calls this
    // after confirming a loop, after recognizing an external matching loop, and
    // on every teardown.
    function sync(target) {
        if (!supported()) return Promise.resolve();
        return enqueue(() => (target ? doActivate(target) : doClear('section-practice-sync-none')));
    }

    // Core releases the record itself on song/context replacement. Drop our key
    // when that happens (only for OUR source — another registrant's clear must
    // not disturb our bookkeeping), so re-arming the same window later
    // dispatches again instead of being deduped against a record core already
    // removed.
    function onOverrideCleared(event) {
        const payload = event && event.detail && event.detail.payload;
        if (payload && payload.source === SECTION_PRACTICE_SOURCE) activeKey = null;
    }

    return {
        source: SECTION_PRACTICE_SOURCE,
        supported,
        isActive,
        activate,
        clear,
        sync,
    };
}
