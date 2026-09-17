'use strict';
// Contract coverage for the opt-in coordinated frame driver. The highway
// factory is browser-closure shaped, so these assertions lock the public
// scheduling and bundle wiring without reimplementing its whole environment.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const highway = fs.readFileSync(path.join(__dirname, '..', '..', 'static', 'highway.js'), 'utf8');

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
    const bundle = block('function _makeBundle(frameTime, frameId)');
    assert.match(api, /hwState\._frameTime = frameTime/);
    assert.match(api, /hwState\._frameId = frameId/);
    assert.match(bundle, /b\.frameTime = frameTime/);
    assert.match(bundle, /b\.frameId = frameId/);
});

test('coordinated frames use their supplied timestamp for clock decisions', () => {
    const bundle = block('function _makeBundle(frameTime, frameId)');
    const draw = block('function draw()');
    assert.match(bundle, /const renderNow = Number\.isFinite\(frameTime\) \? frameTime : performance\.now\(\)/);
    assert.match(draw, /const _nowP = Number\.isFinite\(frameTime\) \? frameTime : performance\.now\(\)/);
});

test('private scheduling stays dormant while an external driver is active', () => {
    const schedule = block('function _scheduleDraw(frameTime)');
    assert.match(schedule, /if \(hwState\._externalFrameDriver\) \{[\s\S]*hwState\.animFrame = null;[\s\S]*return;/);
});
