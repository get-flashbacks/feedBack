// feedBack#133 — minHost floor diagnostic: prerelease-aware comparison,
// the unset/placeholder/real/invalid value classes, and the gap helper.
//
// Runs the real static/js/host-version.js in a vm sandbox (ES-module
// syntax stripped the same way section_practice_difficulty.test.js does)
// so these exercise the shipped code, not a copy.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..', '..');
const SOURCE = path.join(ROOT, 'static', 'js', 'host-version.js');

function load() {
    const raw = fs.readFileSync(SOURCE, 'utf8').replace(/^export /gm, '');
    const sandbox = { console };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(
        raw
        + '\nglobalThis.compareHostVersions = compareHostVersions;'
        + '\nglobalThis.classifyMinHost = classifyMinHost;'
        + '\nglobalThis.minHostStatus = minHostStatus;'
        + '\nglobalThis.describeMinHostGap = describeMinHostGap;'
        + '\nglobalThis.minHostGaps = minHostGaps;',
        sandbox,
        { filename: 'host-version.js' },
    );
    return sandbox;
}

const HOST = '0.3.0-alpha.2';

test('prerelease ordering is correct (alpha.2 < alpha.10 < release)', () => {
    const { compareHostVersions } = load();
    assert.equal(compareHostVersions('0.3.0-alpha.2', '0.3.0-alpha.10'), -1);
    assert.equal(compareHostVersions('0.3.0-alpha.10', '0.3.0'), -1);
    assert.equal(compareHostVersions('0.3.0-alpha.2', '0.3.0-alpha.2'), 0);
    assert.equal(compareHostVersions('0.3.0', '0.3.0-alpha.10'), 1);
});

test('core compares numerically, missing parts are zero', () => {
    const { compareHostVersions } = load();
    assert.equal(compareHostVersions('0.3', '0.3.0'), 0);
    assert.equal(compareHostVersions('2.0.0', '10.0.0'), -1);
    assert.equal(compareHostVersions('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1);
    assert.equal(compareHostVersions('v0.3.0-alpha.2', '0.3.0-alpha.2'), 0);
    assert.equal(compareHostVersions('0.3.0+build.5', '0.3.0'), 0);
    assert.equal(compareHostVersions('0.3.0-alpha.2-e5339c0', '0.3.0-alpha.2'), 1);
});

test('non-bare versions throw instead of miscomparing', () => {
    const { compareHostVersions } = load();
    for (const bad of ['>=1.2', '^0.3', 'abc', '1.2-beta!']) {
        assert.throws(() => compareHostVersions(bad, '1.0.0'), /not a bare version/);
    }
    assert.throws(() => compareHostVersions('1.0.0', '>=1.2'), /not a bare version/);
});

test('the three value classes plus invalid', () => {
    const { classifyMinHost } = load();
    assert.equal(classifyMinHost(undefined), 'unset');
    assert.equal(classifyMinHost(null), 'unset');
    assert.equal(classifyMinHost(''), 'unset');
    assert.equal(classifyMinHost('   '), 'unset');
    assert.equal(classifyMinHost(7), 'unset');
    assert.equal(classifyMinHost('1.0.0'), 'placeholder');
    assert.equal(classifyMinHost('0.3.0-alpha.2'), 'real');
    assert.equal(classifyMinHost('0.3.0'), 'real');
    assert.equal(classifyMinHost('>=1.2'), 'invalid');
    assert.equal(classifyMinHost('abc'), 'invalid');
});

test('status: real floors compare, placeholders pass through, unknown hosts fail open', () => {
    const { minHostStatus } = load();
    assert.equal(minHostStatus('0.3.0-alpha.10', HOST), 'unmet');
    assert.equal(minHostStatus('0.3.0-alpha.2', HOST), 'ok');
    assert.equal(minHostStatus('0.2.0', HOST), 'ok');
    assert.equal(minHostStatus('0.3.0', HOST), 'unmet');
    assert.equal(minHostStatus(undefined, HOST), 'unset');
    assert.equal(minHostStatus('1.0.0', '0.1.0'), 'placeholder');
    assert.equal(minHostStatus('1.0.0', '9.9.9'), 'placeholder');
    assert.equal(minHostStatus('>=1.2', HOST), 'invalid');
    assert.equal(minHostStatus('9.9.9', 'unknown'), 'ok');
    assert.equal(minHostStatus('9.9.9', ''), 'ok');
});

test('unmet plugins produce a gap naming plugin, need, and have', () => {
    const { minHostGaps } = load();
    const gaps = minHostGaps([
        { id: 'needy', min_host: '0.3.0-alpha.10', min_host_status: 'unmet' },
        { id: 'fine', min_host: '0.3.0-alpha.1', min_host_status: 'ok' },
        { id: 'old', min_host: '1.0.0', min_host_status: 'placeholder' },
        { id: 'plain', min_host_status: 'unset' },
    ], HOST);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].id, 'needy');
    assert.match(gaps[0].message, /needy/);
    assert.match(gaps[0].message, /0\.3\.0-alpha\.10/);
    assert.match(gaps[0].message, /0\.3\.0-alpha\.2/);
});

test('rows from older hosts without min_host_status are evaluated locally', () => {
    const { minHostGaps } = load();
    const gaps = minHostGaps([
        { id: 'legacy-needy', min_host: '0.3.0-alpha.10' },
        { id: 'legacy-fine', min_host: '0.2.0' },
    ], HOST);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].id, 'legacy-needy');
});
