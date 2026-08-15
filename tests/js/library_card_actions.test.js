'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const reg = require('../../static/capabilities/library-card-actions.js');

function freshIds() { reg.snapshot().actions.forEach((a) => reg.unregister(a.id)); }

test('register + list returns applicable actions sorted by order', () => {
    freshIds();
    reg.register({ id: 'b', label: 'B', order: 20, run() {} });
    reg.register({ id: 'a', label: 'A', order: 10, run() {} });
    const ids = reg.list({ filename: 'x.archive' }).map((a) => a.id);
    assert.deepStrictEqual(ids, ['a', 'b']);
});

test('applies() filters out non-applicable actions', () => {
    freshIds();
    reg.register({ id: 'bassonly', label: 'Bass', applies: (s) => s.format === 'sloppak', run() {} });
    assert.strictEqual(reg.list({ filename: 'x.archive', format: 'archive' }).length, 0);
    assert.strictEqual(reg.list({ filename: 'y.sloppak', format: 'sloppak' }).length, 1);
});

test('enabled() reflected in the summary but action still listed', () => {
    freshIds();
    reg.register({ id: 'maybe', label: 'Maybe', enabled: (s) => !!s.allow, run() {} });
    const off = reg.list({ filename: 'x' })[0];
    assert.strictEqual(off.enabled, false);
    const on = reg.list({ filename: 'x', allow: true })[0];
    assert.strictEqual(on.enabled, true);
});

test('label and icon callbacks resolve per listed song', () => {
    freshIds();
    reg.register({
        id: 'difficulty',
        label: (s) => `${s.progress}%`,
        icon: (s) => (s.progress >= 90 ? '*' : ''),
        run() {},
    });
    assert.deepStrictEqual(
        reg.list({ filename: 'easy.sloppak', progress: 42 }).map((a) => ({ label: a.label, icon: a.icon })),
        [{ label: '42%', icon: '' }],
    );
    assert.deepStrictEqual(
        reg.list({ filename: 'done.sloppak', progress: 96 }).map((a) => ({ label: a.label, icon: a.icon })),
        [{ label: '96%', icon: '*' }],
    );
});

test('label and icon callback errors fall back safely', () => {
    freshIds();
    reg.register({
        id: 'bad-dynamic',
        label() { throw new Error('label unavailable'); },
        icon() { throw new Error('icon unavailable'); },
        run() {},
    });
    const [action] = reg.list({ filename: 'song.sloppak' });
    assert.strictEqual(action.label, 'bad-dynamic');
    assert.strictEqual(action.icon, '');
});

test('run() invokes the handler and reports handled', async () => {
    freshIds();
    let got = null;
    reg.register({ id: 'go', label: 'Go', run: (song) => { got = song.filename; return 'done'; } });
    const r = await reg.run('go', { filename: 'song.archive' }, {});
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.outcome, 'handled');
    assert.strictEqual(got, 'song.archive');
});

test('run() of a disabled / non-applicable / unknown action does not throw', async () => {
    freshIds();
    reg.register({ id: 'dis', label: 'Dis', enabled: () => false, run() { throw new Error('should not run'); } });
    assert.strictEqual((await reg.run('dis', {})).outcome, 'disabled');
    assert.strictEqual((await reg.run('nope', {})).outcome, 'no-action');
});

test('run() surfaces handler errors as failed (no throw)', async () => {
    freshIds();
    reg.register({ id: 'boom', label: 'Boom', run() { throw new Error('kaboom'); } });
    const r = await reg.run('boom', {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.outcome, 'failed');
});

test('unregister removes the action', () => {
    freshIds();
    const off = reg.register({ id: 'temp', label: 'T', run() {} });
    assert.strictEqual(reg.list({}).length, 1);
    off();
    assert.strictEqual(reg.list({}).length, 0);
});

test('bad specs are rejected (no id / no run)', () => {
    freshIds();
    reg.register({ label: 'no id', run() {} });
    reg.register({ id: 'no-run' });
    assert.strictEqual(reg.list({}).length, 0);
});
