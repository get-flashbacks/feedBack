// Per-instance hand filter (feedBack#849 / splitscreen#66). applySetting and
// getSetting don't touch WebGL, so the real factory runs headless here; the
// init() and settings-event paths need three.js and are guarded at source level
// like tests/instance_invariants.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const store = new Map();
global.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
global.document = {
    addEventListener() {}, getElementById() { return null },
    createElement() { return { style: {} }; }, head: { appendChild() {} },
};
global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
};
global.CustomEvent = class { constructor(type, opts) { this.type = type; this.detail = opts && opts.detail; } };
require('../screen.js');
const factory = window.feedBackViz_keys_highway_3d;
const src = fs.readFileSync(require.resolve('../screen.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(require.resolve('../plugin.json'), 'utf8'));

test('handFilter is per renderer instance and falls back to the global setting', () => {
    store.clear();
    const a = factory();
    const b = factory();
    assert.equal(a.getSetting('handFilter'), 'both');
    a.applySetting('handFilter', 'left');
    b.applySetting('handFilter', 'right');
    assert.equal(a.getSetting('handFilter'), 'left');
    assert.equal(b.getSetting('handFilter'), 'right');
    store.set('keys3d_hand_filter', 'right');
    a.applySetting('handFilter', 'bogus');
    assert.equal(a.getSetting('handFilter'), 'right', 'an invalid value clears the override to the global');
    assert.equal(b.getSetting('handFilter'), 'right');
    assert.equal(a.getSetting('other'), undefined);
    assert.doesNotThrow(() => a.applySetting('other', 1));
});

test('init() and the global settings event respect a per-instance override', () => {
    assert.match(src, /_handFilter = _handOverride \|\| readHandFilterSetting\(\);/);
    assert.match(src, /HAND_FILTERS\.indexOf\(d\.handFilter\) !== -1 && !_handOverride\)/);
    // Re-applying the same value must not rebuild or reset scoring mid-song.
    assert.match(src, /function _setHandFilter\(next\) \{\s*if \(next === _handFilter\) return;/);
});

test('plugin.json declares handFilter with the ids the renderer accepts', () => {
    const hand = manifest.capabilities.visualization.settings.find((s) => s.key === 'handFilter');
    assert.equal(hand.type, 'select');
    assert.deepEqual(hand.options.map((o) => o.id), ['both', 'left', 'right']);
});
