const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'static', 'highway.js'), 'utf8');

test('offline frame rendering uses the explicit chart time and disables clock interpolation', () => {
    const start = source.indexOf('renderFrameAt(t) {');
    assert.ok(start >= 0, 'renderFrameAt API must exist');
    const body = source.slice(start, source.indexOf('\n        },', start));
    const setTime = body.indexOf('this.setTime(time)');
    const paused = body.indexOf('bundle.isPlaying = false');
    const draw = body.indexOf('hwState._renderer.draw(bundle)');
    assert.ok(setTime >= 0 && paused > setTime && draw > paused,
        'set explicit time, disable interpolation, then synchronously draw');
});

test('offline frame rendering refuses invalid timestamps and unready charts', () => {
    const start = source.indexOf('renderFrameAt(t) {');
    const body = source.slice(start, source.indexOf('\n        },', start));
    assert.match(body, /!Number\.isFinite\(time\)/);
    assert.match(body, /!hwState\.ready/);
    assert.match(body, /return false/);
});
