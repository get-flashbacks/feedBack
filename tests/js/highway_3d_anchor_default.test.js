// Regression coverage for getChartAnchorAt's pre-first-anchor fallback in
// plugins/highway_3d/screen.js — mirrors static/highway.js getAnchorAt's
// fix (see tests/js/highway_chart_transform.test.js). Before this fix, a
// chart whose anchor list started minutes into the song (a data gap) would
// zoom the 3D highway's lane/fret-row/camera lookahead to that far-later
// anchor's fret window during the intro.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCREEN_JS = path.join(__dirname, '..', '..', 'plugins', 'highway_3d', 'screen.js');

// Brace-balanced extraction (same helper shape as highway_string_colors.test.js).
function extractBlock(src, signature) {
    const start = src.indexOf(signature);
    assert.ok(start !== -1, `signature '${signature}' not found`);
    const openBrace = src.indexOf('{', start);
    assert.ok(openBrace !== -1, `opening brace after '${signature}' not found`);
    let depth = 1;
    let i = openBrace + 1;
    while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    assert.ok(depth === 0, `unbalanced braces after '${signature}'`);
    return src.slice(start, i);
}

function loadGetChartAnchorAt() {
    const src = fs.readFileSync(SCREEN_JS, 'utf8');
    const constStart = src.indexOf('const DEFAULT_CHART_ANCHOR');
    assert.ok(constStart !== -1, 'DEFAULT_CHART_ANCHOR not found');
    const constEnd = src.indexOf(';', constStart) + 1;
    const snippet = [
        src.slice(constStart, constEnd),
        extractBlock(src, 'function getChartAnchorAt(anchorArr, t)'),
        'return { getChartAnchorAt, DEFAULT_CHART_ANCHOR };',
    ].join('\n');
    return new Function(snippet)();
}

test('getChartAnchorAt returns null for an empty/missing anchor list', () => {
    const { getChartAnchorAt } = loadGetChartAnchorAt();
    assert.equal(getChartAnchorAt([], 5), null);
    assert.equal(getChartAnchorAt(null, 5), null);
});

test('getChartAnchorAt falls back to the default before the first anchor, not the first anchor itself', () => {
    const { getChartAnchorAt, DEFAULT_CHART_ANCHOR } = loadGetChartAnchorAt();
    const anchors = [{ time: 227, fret: 6, width: 4 }];
    assert.deepEqual(getChartAnchorAt(anchors, 0.3), DEFAULT_CHART_ANCHOR);
    assert.deepEqual(getChartAnchorAt(anchors, 0.3), { fret: 1, width: 4 });
});

test('getChartAnchorAt returns the same DEFAULT_CHART_ANCHOR reference across calls', () => {
    // Regression guard: a call site (search `getChartAnchorAt(anchors,
    // _susAbsT) !==`) compares two calls by reference to detect an anchor
    // change. Returning a fresh object literal per call would make that
    // comparison always "different" while both times are pre-first-anchor,
    // even though nothing actually changed.
    const { getChartAnchorAt } = loadGetChartAnchorAt();
    const anchors = [{ time: 227, fret: 6, width: 4 }];
    assert.equal(getChartAnchorAt(anchors, 0.3), getChartAnchorAt(anchors, 10));
});

test('getChartAnchorAt returns the real anchor once t reaches it', () => {
    const { getChartAnchorAt } = loadGetChartAnchorAt();
    const anchors = [
        { time: 0, fret: 1, width: 4 },
        { time: 10, fret: 6, width: 4 },
    ];
    assert.deepEqual(getChartAnchorAt(anchors, 5), { time: 0, fret: 1, width: 4 });
    assert.deepEqual(getChartAnchorAt(anchors, 10), { time: 10, fret: 6, width: 4 });
});
