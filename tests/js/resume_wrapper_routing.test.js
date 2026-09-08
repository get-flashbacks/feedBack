// Resume-through-a-playSong-wrapper regression (feedBack#74 review finding).
//
// resumeLastSession() calls window.playSong(...) instead of the bare session.js
// binding, specifically so playSong-wrapping plugins (splitscreen, section_map,
// ...) observe resume loads like any other fresh play. But every real wrapper in
// the ecosystem forwards only (filename, arrangement) to the next link in the
// chain and drops the options object — so options.resume never survives the
// wrapper hop. Without a fix, core's own playSong() would then see
// options === undefined and clobber S.pendingResume to null on the very call
// meant to restore it: resume plays from the top, and the snapshot consumption
// throws away the only copy of the saved position.
//
// The fix has two halves that only work together:
//   1. resume-session.js pre-arms S.pendingResume directly, synchronously,
//      immediately before calling window.playSong — nothing else can touch
//      S.pendingResume in between (single JS thread, no intervening await at
//      that callsite).
//   2. session.js's playSong() preserves an already-armed S.pendingResume
//      instead of nulling it when its own options.resume is absent.
//
// This can't be exercised as a headless unit test (playSong() is deeply coupled
// to the DOM/audio element/highway instance) — the behavioral case lives in
// tests/browser/resume-session.spec.ts's "...through a playSong wrapper that
// drops options" test, run via Playwright (not part of the node --test CI job).
// This file pins the static shape of the fix itself, in the spirit of
// host_contract.test.js, so CI catches a regression even though the behavioral
// test isn't wired into it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const RESUME_SESSION_JS = fs.readFileSync(path.join(ROOT, 'static', 'js', 'resume-session.js'), 'utf8');
const SESSION_JS = fs.readFileSync(path.join(ROOT, 'static', 'js', 'session.js'), 'utf8');

test('resumeLastSession() pre-arms S.pendingResume before (not after) calling window.playSong', () => {
    const fnStart = RESUME_SESSION_JS.indexOf('export async function resumeLastSession');
    assert.ok(fnStart >= 0, 'resumeLastSession() not found in resume-session.js');
    const fnEnd = RESUME_SESSION_JS.indexOf('\n}', fnStart);
    const body = RESUME_SESSION_JS.slice(fnStart, fnEnd);

    const armIdx = body.indexOf('S.pendingResume = resume;');
    const callIdx = body.indexOf('await window.playSong(snap.f, snap.a, { resume });');
    assert.ok(armIdx >= 0, 'resumeLastSession() must pre-arm S.pendingResume before calling window.playSong');
    assert.ok(callIdx >= 0, 'resumeLastSession() must call window.playSong(snap.f, snap.a, { resume })');
    assert.ok(
        armIdx < callIdx,
        'S.pendingResume must be armed BEFORE the window.playSong call, not after — arming it after '
        + 'the call is too late for a wrapper-forwarded invocation to see it',
    );

    // No await between the two — an intervening await would give something else
    // a chance to run and touch S.pendingResume before playSong() reads it,
    // breaking the single-threaded guarantee the fix relies on.
    const between = body.slice(armIdx, callIdx);
    assert.ok(
        !/\bawait\b/.test(between),
        'no `await` may appear between arming S.pendingResume and calling window.playSong — '
        + 'that gap is what makes the pre-arm race-free',
    );
});

test("session.js's playSong() preserves a pre-armed S.pendingResume instead of clobbering it to null", () => {
    const fnStart = SESSION_JS.indexOf('export async function playSong(');
    assert.ok(fnStart >= 0, 'playSong() not found in session.js');
    // The pendingResume/_pendingAutostart decision sits in the first ~150 lines
    // of the function body; bound the search so a match elsewhere in the file
    // (there is none today, but this is a source-scan, not a parser) can't
    // produce a false pass.
    const body = SESSION_JS.slice(fnStart, fnStart + 6000);

    const optionsArmIdx = body.indexOf('S.pendingResume = options.resume;');
    assert.ok(optionsArmIdx >= 0, 'playSong() must still arm S.pendingResume from options.resume when present');

    const preserveMatch = body.match(/else if\s*\(\s*S\.pendingResume\s*&&\s*Number\(S\.pendingResume\.position\)\s*>\s*0\s*\)\s*\{([\s\S]*?)\}/);
    assert.ok(
        preserveMatch,
        'playSong() must have an `else if (S.pendingResume && ...)` branch between the options.resume '
        + 'branch and the final else, preserving a pre-armed resume request that a wrapper dropped '
        + 'from options',
    );
    assert.ok(
        !/S\.pendingResume\s*=/.test(preserveMatch[1]),
        'the branch preserving a pre-armed S.pendingResume must not itself reassign it — that would '
        + 'defeat the whole point of preserving it',
    );

    const finalElseMatch = body.match(/\}\s*else\s*\{\s*S\.pendingResume\s*=\s*null;/);
    assert.ok(finalElseMatch, 'playSong() must still null S.pendingResume on a genuine fresh (non-resume) play');
});
