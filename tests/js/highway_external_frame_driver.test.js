'use strict';
// Contract coverage for the opt-in coordinated frame driver. The highway
// factory is browser-closure shaped, so these assertions lock the public
// scheduling and bundle wiring without reimplementing its whole environment.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// The JS suite always runs from the repository root (package.json:test:js),
// so keep this source fixture literal rather than constructing a path from
// external input.
const highway = fs.readFileSync('static/highway.js', 'utf8');

function block(signature) {
    const start = highway.indexOf(signature);
    assert.ok(start >= 0, `missing ${signature}`);
    const open = highway.indexOf('{', start);
    let depth = 1;
    let end = open + 1;
    while (depth && end < highway.length) {
        if (highway[end] === '{') depth++;
        else if (highway[end] === '}') depth--;
        end++;
    }
    assert.equal(depth, 0, `${signature} must be balanced`);
    return highway.slice(start, end);
}

test('external driver cancels the private rAF and resumes it when released', () => {
    const api = block('setExternalFrameDriver(enabled)');
    assert.match(api, /cancelAnimationFrame\(hwState\.animFrame\)/);
    assert.match(api, /else if \(hwState\.ready && !hwState\.animFrame\)/);
    assert.match(api, /_scheduleDraw\(\)/);
});

test('an external frame carries its timestamp and id through the render bundle', () => {
    const api = block('renderFrame(frameTime, frameId)');
    const draw = block('function draw(frameTime, frameId)');
    const bundle = block('function _makeBundle(frameTime, frameId)');
    assert.match(api, /return draw\(frameTime, frameId\)/);
    assert.match(draw, /_makeBundle\(frameTime, hwState\._frameIdx\)/);
    assert.match(bundle, /b\.frameTime = frameTime/);
    assert.match(bundle, /b\.frameId = frameId/);
});

test('offline export can paint an explicit chart time without taking over scheduling', () => {
    const api = block('renderFrameAt(time)');
    assert.match(api, /!hwState\.ready \|\| !Number\.isFinite\(time\)/);
    assert.match(api, /api\.setTime\(time\)/);
    assert.match(api, /return draw\(\)/);
    assert.doesNotMatch(api, /setExternalFrameDriver/);
});

test('coordinated frames use their supplied timestamp for clock decisions', () => {
    const bundle = block('function _makeBundle(frameTime, frameId)');
    const draw = block('function draw(frameTime, frameId)');
    assert.match(bundle, /const renderNow = Number\.isFinite\(frameTime\) \? frameTime : performance\.now\(\)/);
    assert.match(draw, /const _nowP = Number\.isFinite\(frameTime\) \? frameTime : performance\.now\(\)/);
});

test('private scheduling stays dormant while an external driver is active', () => {
    const schedule = block('function _scheduleDraw(frameTime)');
    assert.match(schedule, /if \(hwState\._externalFrameDriver\) \{[\s\S]*hwState\.animFrame = null;[\s\S]*return;/);
});
