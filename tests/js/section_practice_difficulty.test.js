// feedBack#140 — Section Practice as the practice-difficulty PRODUCER.
//
// Two layers:
//   1. The real bridge module (static/js/section-practice-difficulty.js) run in a
//      vm with a hand-rolled capability dispatch double, so the producer-side
//      bookkeeping (dedupe by window+percentage, idempotent clear, core-release
//      handling, capability-absent degradation) is exercised — not regex-guessed.
//   2. Source-level assertions on static/js/section-practice.js that the
//      lifecycle wiring is where it must be: activation only AFTER a confirmed
//      loop, clearing inside the single teardown funnel, and the pin gate that
//      keeps the feature inert (and off charts without phrase data).
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..', '..');
const BRIDGE_JS = path.join(ROOT, 'static', 'js', 'section-practice-difficulty.js');
const SECTION_JS = path.join(ROOT, 'static', 'js', 'section-practice.js');

function plain(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function loadBridge() {
    // The bridge is an ES module; the vm sandbox evaluates plain script text.
    const raw = fs.readFileSync(BRIDGE_JS, 'utf8').replace(/^export /gm, '');
    const code = raw
        + '\nglobalThis.SECTION_PRACTICE_SOURCE = SECTION_PRACTICE_SOURCE;'
        + '\nglobalThis.createSectionPracticeDifficulty = createSectionPracticeDifficulty;';
    const sandbox = { console };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: 'section-practice-difficulty.js' });
    return sandbox;
}

function makeHarness(opts = {}) {
    const calls = [];
    const listeners = new Map();
    let outcome = opts.outcome || 'handled';
    let throws = !!opts.throws;
    const context = opts.context === undefined ? { player_id: 'main' } : opts.context;
    const window = {
        console,
        feedBack: {
            capabilities: opts.caps === false ? undefined : {
                dispatch(request) {
                    calls.push(plain(request));
                    if (throws) return Promise.reject(new Error('boom'));
                    const resolved = typeof outcome === 'function' ? outcome(request) : outcome;
                    return Promise.resolve({ outcome: resolved });
                },
            },
            playerContexts: opts.contexts === false ? undefined : { getActive: () => context },
            on(type, fn) {
                const list = listeners.get(type) || [];
                list.push(fn);
                listeners.set(type, list);
            },
        },
    };
    return {
        window,
        calls,
        listeners,
        setOutcome: (v) => { outcome = v; },
        setThrows: (v) => { throws = !!v; },
        emitCleared: (source) => {
            for (const fn of (listeners.get('practice-difficulty:override-cleared') || [])) {
                fn({ type: 'practice-difficulty:override-cleared', detail: { payload: { source } } });
            }
        },
    };
}

function target(overrides = {}) {
    return {
        difficultyPct: 40,
        startTime: 12.5,
        endTime: 24,
        phraseIndices: [3],
        label: 'Section practice · Verse 2',
        ...overrides,
    };
}

test('the bridge source id is the documented stable core identifier', () => {
    const sandbox = loadBridge();
    assert.equal(sandbox.SECTION_PRACTICE_SOURCE, 'core.section-practice');
});

test('sync activates the override with a snake_case payload and the bound context', async () => {
    const sandbox = loadBridge();
    const h = makeHarness();
    const bridge = sandbox.createSectionPracticeDifficulty({ window: h.window });

    assert.equal(bridge.supported(), true);
    await bridge.sync(target());

    assert.equal(h.calls.length, 1);
    const call = h.calls[0];
    assert.equal(call.capability, 'practice-difficulty');
    assert.equal(call.command, 'activate');
    assert.equal(call.source, 'core.section-practice');
    assert.equal(call.payload.difficulty_pct, 40);
    assert.equal(call.payload.start_time, 12.5);
    assert.equal(call.payload.end_time, 24);
    assert.deepEqual(call.payload.phrase_indices, [3]);
    assert.equal(call.payload.label, 'Section practice · Verse 2');
    assert.deepEqual(call.payload.player_context, { player_id: 'main' });
    assert.equal(bridge.isActive(), true);
});

test('an unchanged window+percentage is deduped, not re-dispatched on every reconcile', async () => {
    const sandbox = loadBridge();
    const h = makeHarness();
    const bridge = sandbox.createSectionPracticeDifficulty({ window: h.window });

    await bridge.sync(target());
    await bridge.sync(target());
    await bridge.sync(target({ label: 'a different label' }));
    assert.equal(h.calls.length, 1, 'same window+percentage must not re-dispatch');
});

test('a changed window or percentage updates the override in place', async () => {
    const sandbox = loadBridge();
    const h = makeHarness();
    const bridge = sandbox.createSectionPracticeDifficulty({ window: h.window });

    await bridge.sync(target({ difficultyPct: 40 }));
    await bridge.sync(target({ difficultyPct: 55 }));
    await bridge.sync(target({ difficultyPct: 55, startTime: 13 }));

    assert.equal(h.calls.length, 3);
    assert.equal(h.calls[1].payload.difficulty_pct, 55);
    assert.equal(h.calls[2].payload.start_time, 13);
    assert.equal(bridge.isActive(), true);
});

test('sync(null) clears once; repeated sync(null)/clear() never double-dispatch', async () => {
    const sandbox = loadBridge();
    const h = makeHarness();
    const bridge = sandbox.createSectionPracticeDifficulty({ window: h.window });

    await bridge.sync(target());
    await bridge.sync(null);
    await bridge.sync(null);
    await bridge.clear('teardown');

    assert.equal(h.calls.length, 2, 'one activate + exactly one clear');
    assert.equal(h.calls[1].command, 'clear');
    assert.equal(bridge.isActive(), false);
    assert.equal(await bridge.clear('again'), false);
    assert.equal(h.calls.length, 2);
});

test('clearing an override that was never activated dispatches nothing', async () => {
    const sandbox = loadBridge();
    const h = makeHarness();
    const bridge = sandbox.createSectionPracticeDifficulty({ window: h.window });

    assert.equal(await bridge.clear('nothing'), false);
    assert.equal(h.calls.length, 0);
});

test('a failed activation records no key, so a later reconcile can retry', async () => {
    const sandbox = loadBridge();
    const h = makeHarness({ outcome: 'no-target' });
    const bridge = sandbox.createSectionPracticeDifficulty({ window: h.window });

    await bridge.sync(target());
    assert.equal(bridge.isActive(), false, 'no-target must not be recorded as live');

    h.setOutcome('handled');
    await bridge.sync(target());
    assert.equal(h.calls.length, 2, 'the same window retries after a failed activation');
    assert.equal(bridge.isActive(), true);
});

test('a throwing dispatch degrades to no-op without leaking an active key', async () => {
    const sandbox = loadBridge();
    const h = makeHarness({ throws: true });
    const bridge = sandbox.createSectionPracticeDifficulty({ window: h.window });

    await assert.doesNotReject(() => bridge.sync(target()));
    assert.equal(bridge.isActive(), false);
});

test('without the capability the bridge is inert and never dispatches', async () => {
    const sandbox = loadBridge();
    const h = makeHarness({ caps: false });
    const bridge = sandbox.createSectionPracticeDifficulty({ window: h.window });

    assert.equal(bridge.supported(), false);
    await assert.doesNotReject(() => bridge.sync(target()));
    await assert.doesNotReject(() => bridge.clear('x'));
    assert.equal(h.calls.length, 0);
    assert.equal(bridge.isActive(), false);
});

test('without a bound player context activation is skipped (the domain would say no-target)', async () => {
    const sandbox = loadBridge();
    const h = makeHarness({ contexts: false });
    const bridge = sandbox.createSectionPracticeDifficulty({ window: h.window });

    await bridge.sync(target());
    assert.equal(h.calls.length, 0);
    assert.equal(bridge.isActive(), false);
});

test('a core release of OUR source re-arms the same window on the next sync', async () => {
    const sandbox = loadBridge();
    const h = makeHarness();
    const bridge = sandbox.createSectionPracticeDifficulty({ window: h.window });

    await bridge.sync(target());
    assert.equal(h.calls.length, 1);

    // Core dropped the record on song/context replacement.
    h.emitCleared('core.section-practice');
    assert.equal(bridge.isActive(), false);

    // Re-arming the identical window must dispatch again, not dedupe against a
    // record that no longer exists.
    await bridge.sync(target());
    assert.equal(h.calls.length, 2);
});

test('a release event for ANOTHER source does not disturb our bookkeeping', async () => {
    const sandbox = loadBridge();
    const h = makeHarness();
    const bridge = sandbox.createSectionPracticeDifficulty({ window: h.window });

    await bridge.sync(target());
    h.emitCleared('some_other_plugin');
    assert.equal(bridge.isActive(), true);
    await bridge.sync(target());
    assert.equal(h.calls.length, 1, 'still deduped — our record is untouched');
});

test('a vocal (karaoke) context is skipped without dispatching a rejected request', async () => {
    const sandbox = loadBridge();
    const h = makeHarness({ context: { player_id: 'main', role: 'karaoke' } });
    const bridge = sandbox.createSectionPracticeDifficulty({ window: h.window });

    await bridge.sync(target());
    assert.equal(h.calls.length, 0, 'no dispatch for a context the domain would deny');
    assert.equal(bridge.isActive(), false);
});

test('a clear that arrives while an activate is in flight still releases the override', async () => {
    // The serialization contract: without it, the clear would see activeKey
    // null, no-op, and the slower activate would then land and leak.
    const sandbox = loadBridge();
    const calls = [];
    const resolvers = [];
    const window = {
        console,
        feedBack: {
            capabilities: {
                dispatch(request) {
                    calls.push(plain(request));
                    return new Promise((resolve) => resolvers.push(resolve));
                },
            },
            playerContexts: { getActive: () => ({ player_id: 'main' }) },
            on() {},
        },
    };
    const bridge = sandbox.createSectionPracticeDifficulty({ window });
    const flush = () => new Promise((r) => setTimeout(r, 0));

    const activating = bridge.sync(target());
    await flush();
    assert.equal(calls.length, 1, 'activate dispatched first');
    assert.equal(calls[0].command, 'activate');

    const clearing = bridge.sync(null);
    await flush();
    assert.equal(calls.length, 1, 'clear is queued behind the in-flight activate');

    resolvers[0]({ outcome: 'handled' });
    await activating;
    await flush();
    assert.equal(calls.length, 2, 'clear runs after the activate resolves');
    assert.equal(calls[1].command, 'clear');

    resolvers[1]({ outcome: 'handled' });
    await clearing;
    assert.equal(bridge.isActive(), false);
});

// ── section-practice.js wiring (source-level) ───────────────────────────────

function extractFunction(src, signature) {
    const start = src.indexOf(signature);
    assert.ok(start >= 0, `${signature} present`);
    // `signature` ends with '(' — match its ')' first, so a default parameter
    // object literal (`opts = {}`) can't be mistaken for the function body.
    let i = start + signature.length;
    let parens = 1;
    while (i < src.length && parens > 0) {
        const ch = src[i];
        if (ch === '(') parens++;
        else if (ch === ')') parens--;
        i++;
    }
    const open = src.indexOf('{', i);
    let depth = 1;
    let j = open + 1;
    while (j < src.length && depth > 0) {
        const ch = src[j];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        j++;
    }
    return src.slice(start, j);
}

test('the pin gate keeps the override inert until a mode-on loop with phrase data exists', () => {
    const src = fs.readFileSync(SECTION_JS, 'utf8');
    const fn = extractFunction(src, 'function _sectionPracticeOverrideTarget()');
    assert.match(fn, /_sectionPracticeDifficultyPct === null\)\s*return null/,
        'no pin set must mean no override');
    assert.match(fn, /if\s*\(!_sectionPracticeMode\)\s*return null/,
        'a loop without Section Practice mode must not hold an override');
    assert.match(fn, /hasPhraseData/, 'charts without a real ladder must be skipped');
    assert.match(fn, /host\.loopA\(\)/, 'the override window is the live A/B loop');
});

test('activation happens only after a confirmed loop, never inside the setLoop retry', () => {
    const src = fs.readFileSync(SECTION_JS, 'utf8');
    const fn = extractFunction(src, 'async function practiceSection(');
    const okIdx = fn.indexOf('if (ok) {');
    const syncIdx = fn.indexOf('_syncSectionPracticeOverride(');
    const elseIdx = fn.indexOf('} else {', okIdx);
    assert.ok(okIdx >= 0 && syncIdx >= 0, 'both the success branch and the sync call exist');
    assert.ok(syncIdx > okIdx && syncIdx < elseIdx,
        'the sync call must live in the `ok` branch, after the loop was confirmed');
    const retry = fn.slice(0, okIdx);
    assert.doesNotMatch(retry, /_syncSectionPracticeOverride/,
        'no activation may be emitted from the retry loop / a failed setLoop');
});

test('the single teardown funnel and the hide path both clear the override', () => {
    const src = fs.readFileSync(SECTION_JS, 'utf8');
    const mode = extractFunction(src, 'export function _setSectionPracticeMode(');
    const elseBranch = mode.slice(mode.indexOf('} else {'));
    assert.match(elseBranch, /_sectionPracticeClearOverride\('mode-off'\)/,
        'turning practice off must release the override');

    const hide = extractFunction(src, 'export function _hideSectionPracticeBar()');
    assert.match(hide, /_sectionPracticeClearOverride\('bar-hidden'\)/,
        'song/arrangement teardown must release the override');
});

test('the difficulty pin control is rendered into the popover', () => {
    const src = fs.readFileSync(SECTION_JS, 'utf8');
    assert.match(src, /onSectionPracticeDifficultyToggle\(\)/,
        'the checkbox wires the toggle handler');
    const barHtml = extractFunction(src, 'function _sectionPracticeBarInnerHtml()');
    assert.match(barHtml, /_sectionPracticeDifficultyControlHtml\(\)/,
        'the bar markup includes the difficulty control');
});

test('the recognizer reconciles the override for an externally armed matching loop', () => {
    const src = fs.readFileSync(SECTION_JS, 'utf8');
    const fn = extractFunction(src, 'export function _syncSectionPracticeFromLoop()');
    assert.match(fn, /_syncSectionPracticeOverride\(\)/,
        'a loop this feature recognizes (incl. a matching Saved Loop) reconciles the override');
});
