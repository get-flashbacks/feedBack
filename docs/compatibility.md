# Compatibility matrix — host APIs vs. plugin features

Which host (`feedBack`) build a plugin feature needs, expressed as **exact
commits** instead of version strings. This is sub-issue 1/5 of
[#102](https://github.com/get-flashbacks/feedBack/issues/102); it is
**documentation only**. Nothing here changes what the loader enforces, adds a
capability check, or blocks a plugin from loading.

> **Nothing in this document is runtime-certified.** Every row is a *source
> audit*: the API was located in the host's history at the commit named, and
> the dependent plugin's source was read to see how it uses it. No row was
> verified by running a plugin against a historical host build. Treat each row
> as "the code path you need arrived in this commit", not as "this build was
> tested end to end". Where a plugin ships executable host-compat fixtures
> (Piano) those tests are noted, because they are stronger evidence than this
> document — but they still run against fake hosts, not real builds.

## Why not version strings

`VERSION` has been reused across incompatible builds. Its whole history in this
repository:

| Commit | Date (UTC) | `VERSION` reads |
|---|---|---|
| `6c11039` | 2026-06-16 | `0.2.9` (file created) |
| `8f800e0` | 2026-06-20 | `0.3.0` |
| `803bd0c` | 2026-07-03 | `0.3.0-alpha.1` |
| `ec1157a` | 2026-08-10 | `0.3.0-alpha.2` (still current) |

`0.3.0-alpha.1` therefore covers the range `803bd0c..ec1157a^` (278 commits)
and `0.3.0-alpha.2` covers `ec1157a..d1980ff` (83 commits as of this audit), so
one version string spans three of the seven APIs in this document.
`0.3.0-alpha.2` is a truthful answer for the four upstream rows below (they all
predate `ec1157a`) and an uninformative one for the three fork rows (they all
postdate it). Until a release identifies a baseline —
[#102](https://github.com/get-flashbacks/feedBack/issues/102)'s proposal — a
commit hash is the only identity that answers the question.

This fork has **no tags and no releases of its own**, so a bare `feedBack`
checkout is identified by `git rev-parse HEAD`. The only relevant tag lives
upstream: `v0.3.0-alpha.1` = `b6169af6` (2026-07-03), which is 14 commits past
`803bd0c` and contains **none** of the seven APIs below.

## The matrix

Host revision audited: `d1980ff` (fork `main`, 2026-10-02). Plugin revisions
audited are listed per row. "Upstream?" is the answer to *"does this commit
exist on `got-feedback/feedBack:main`?"*, not merely "does GitHub know the
SHA".

| # | Commit | Date (UTC) | Provides | Dependent plugin(s) / feature(s) | Required? | Upstream? | Plugin revision audited |
|---|---|---|---|---|---|---|---|
| 1 | [`0dcc913`](https://github.com/got-feedback/feedBack/commit/0dcc9136b6079873c1d2c83459fe54718a0cfbb3) | 2026-07-10 | `lib/dlc_paths.py` — `_resolve_dlc_path` containment helper | Difficulty Ladder ladder generation (`routes.py`); Lyrics Karaoke backend (preferred path, has a fallback) | **Required** for Difficulty Ladder's `routes.py`; **optional** for Lyrics Karaoke | **Upstream** (`main`) | `difficulty_ladder` `9ac046a`; `lyrics-karaoke` `5e9d586` |
| 2 | [`d876ded`](https://github.com/got-feedback/feedBack/commit/d876ded00f9254b13bf4a0587c5645a1edaccf67) | 2026-07-13 | `sloppak.read_member_bytes()` — read one member without unpacking the pack | Difficulty Ladder generation; Feedpakr pack reuse / upgrade / dedup | **Required** for both (Feedpakr: at call time, not at import) | **Upstream** (`main`) | `difficulty_ladder` `9ac046a`; `feedpakr` `29b0396` |
| 3 | [`05be9eb`](https://github.com/got-feedback/feedBack/commit/05be9ebdbe5f77310178772089655dab8f415246) | 2026-07-19 | `chart-transform` capability domain (`static/capabilities/chart-transform.js`) | Chordr automatic chart/diagram enrichment | **Optional** — Chordr's analysis tier works without it; only the enrichment tier needs it | **Upstream** (`main`) | `chordr` `bcf49fa` |
| 4 | [`03e1c1d`](https://github.com/got-feedback/feedBack/commit/03e1c1d57e60ab6c61e5ba8dc9e09294e71ed493) | 2026-07-22 | `/ws/sync/{session_id}` relay WebSocket (`lib/routers/ws_sync.py`) | Splitscreen LAN sharing (cross-device followers) | **Optional** — local split layouts work without it; LAN sharing is the only dependent feature | **Upstream** (`main`) | `splitscreen` `1600e8c` |
| 5 | [`f7c761c`](https://github.com/got-feedback/feedBack/commit/f7c761cf411f70e7d012e25b4224d089f85e1ded) | 2026-09-17 | `Highway.renderFrame()`, `renderFrameAt(time)`, `setExternalFrameDriver(bool)` + shared frame timestamp/ID in the render bundle | Visual Export (deterministic offline frames); Splitscreen's coordinated/bridge frame path | **Required** for Visual Export; **optional** for Splitscreen (feature-detected, warns and degrades) | **Fork-only** — not on upstream `main` | `visual_export` `a7bad12`; `splitscreen` `1600e8c` |
| 6 | [`7633211`](https://github.com/got-feedback/feedBack/commit/76332110d10de1f524c6669ffadad4fc8560fbb9) | 2026-09-17 | `window.feedBack.playerContexts` + the `player-identity` / `player-difficulty.v1` capability owners | Full per-player integration: Splitscreen panel identity, Difficulty Ladder per-player difficulty, Lyrics Karaoke per-player wiring | **Optional** everywhere — every consumer guards and degrades to a single-player / player-unaware path | **Fork-only** — not on upstream `main` | `splitscreen` `1600e8c`; `difficulty_ladder` `9ac046a` |
| 7 | [`e5339c0`](https://github.com/got-feedback/feedBack/commit/e5339c04ff884fabbe5c2051671a82a5742d8728) | 2026-09-23 | Mastery selection by phrase **tier number** + `getPhrases().top_difficulty` | Difficulty Ladder's presentation agreeing with the tiers the host actually renders | **Optional but load-bearing for correctness** — the plugin falls back when `top_difficulty` is absent, and the fallback does not prove agreement | **Fork-only** — not on upstream `main` | `difficulty_ladder` `9ac046a` |

Two plugins have **no row** because their required APIs predate every commit
above and are present in `v0.3.0-alpha.1` (`b6169af6`): **Piano** (records
`0.3.0-alpha.1` as its floor in its `README.md` — not in `plugin.json`, see the
`minHost` section below — and pins that floor as executable fixtures in its own
`tests/host-compat.test.js`) and **basic Split Screen** (local layouts; only its
LAN-sharing and coordinated-render paths need rows 4 and 5).

## Row detail and evidence

### Row 1 — `0dcc913`: `lib/dlc_paths.py`

- Host surface today: `lib/dlc_paths.py:43` (`_resolve_dlc_path`), re-exported
  by `server.py` for its existing call sites.
- **Difficulty Ladder — required.** `routes.py` does
  `from dlc_paths import _resolve_dlc_path` at module top level. A host without
  the module fails the import, so `setup()` never registers the generation
  routes at all; this is not a per-call degrade.
- **Lyrics Karaoke — optional.** `routes.py` tries
  `from dlc_paths import _resolve_dlc_path`, and on `ImportError` falls back to
  `safepath.safe_join` — the containment helper that *was* core's
  `_resolve_dlc_path` in the alpha.1 shape. If neither imports, it returns
  `None` (a 404 the caller already handles) rather than joining unguarded. Note
  the two helpers are not otherwise ordered by strictness: the fallback is
  *stricter* on symlinked song entries, and looser on drive-absolute and
  NUL-bearing names. Containment never weakens either way.

### Row 2 — `d876ded`: `sloppak.read_member_bytes()`

- Host surface today: `lib/sloppak.py:587`.
- **Difficulty Ladder — required.** `routes.py` calls
  `sloppak.read_member_bytes(pack_path, rel)` while reading arrangement/manifest
  members; generation of a ladder from a `.sloppak` fails without it.
- **Feedpakr — required at call time, not at import.** The import of the host's
  `sloppak` module is guarded (`sloppak_mod = None` on `ImportError`, and
  `_read_member` has a standalone zip reader behind it), so the plugin loads on
  a host without `lib/sloppak.py` at all. But a host that *has* `sloppak` and
  predates `d876ded` passes the `is not None` check and then hits a missing
  attribute on the pack reuse/upgrade/dedup paths. The standalone fallback
  therefore covers "no `sloppak` module", not "an old `sloppak` module" — do not
  read it as tolerance for an older host.

### Row 3 — `05be9eb`: `chart-transform` capability

- Host surface today: `static/capabilities/chart-transform.js`, registered in
  the domain table at `static/capabilities.js:131`.
- **Chordr — optional.** The plugin registers a transform provider so
  `highway.getChordTemplates()` picks up generated diagrams with no per-plugin
  integration. Everything else Chordr does (helpers, chord/lyrics view,
  audio-based detection, the server-side analysis callable) reads
  `context["load_sibling"]`, the event bus and long-standing highway getters,
  which predate this commit.
- Failure mode without it: `window.chordr.getChartTransformStatus()` reports a
  no-owner state, and `highway.getChordTemplates()` returns no generated
  diagrams. Nothing throws.

### Row 4 — `03e1c1d`: `/ws/sync/{session_id}` relay

- Host surface today: `lib/routers/ws_sync.py:196`, mounted at
  `server.py:1664`.
- **Splitscreen — optional.** LAN sharing is the only dependent feature; the
  plugin builds the URL at `screen.js:519`. A WebSocket endpoint cannot be
  feature-detected from a page, so the plugin detects the gap by counting
  connect failures (including a constructor that throws outright, which never
  reaches `onclose`) and, past a threshold, warns once and toasts — naming the
  missing relay and the commit that introduced it. Everything else keeps
  working; viewers can simply never join a share.
- The relay is deliberately stateless (no schema, no history, no persistence):
  rooms appear on first join and are collected when the last socket leaves.

### Row 5 — `f7c761c`: coordinated / deterministic frame rendering

- Host surface today: `static/highway.js:3037` (`setExternalFrameDriver`),
  `:3057` (`renderFrame`), `:3071` (`renderFrameAt`).
- **Visual Export — required.** The whole export is driven by explicit song
  timestamps instead of the playback clock. The plugin detects the gap in
  `frameDriverProblem()` and reports the core requirement and the Splitscreen
  requirement separately rather than failing opaquely.
- Visual Export also needs Splitscreen's `beginOfflineRender()` /
  `renderFrameAt()` / `endOfflineRender()` bridge for split-layout export. That
  bridge is a **Splitscreen** revision, not a core one — cite Splitscreen
  1.14.8 (commit `2301dd5`, on Splitscreen's default branch) — and it is
  all-or-nothing: `renderFrameAt` returns `false` unless offline rendering is
  active, so a host with `renderFrameAt` but no `beginOfflineRender` can never
  paint a frame. (`87e3622a`, which Visual Export's own error text also cites,
  is a side-branch commit that diverged from Splitscreen's default branch and
  is not reachable from it; do not use it as a floor.)
- **Splitscreen — optional.** Panel highways feature-detect the frame API
  (`_canDriveFrames` requires `setExternalFrameDriver` and `renderFrame`;
  `renderFrameAt` is checked separately). When it is absent the
  coordinated-frame path degrades **silently**: incapable panels keep their own
  rAF loop and nothing is logged. The `coordinated-frames` warn-once fires only
  from `beginOfflineRender()`, i.e. when an exporter such as Visual Export asks
  for an offline split frame.
- What this commit does *not* introduce: `getSongInfo()` and `getSections()`,
  which Visual Export also calls, are long-standing `static/highway.js` APIs.

### Row 6 — `7633211`: `playerContexts` and `player-difficulty.v1`

- Host surface today: `static/capabilities/player-identity.js:112` and `:117`
  (`fb.playerContexts`).
- **Optional in every consumer.** Splitscreen reads
  `window.feedBack && window.feedBack.playerContexts` behind a guard and warns
  that panels stay anonymous. Difficulty Ladder gates its per-player write on
  `fb.capabilities.dispatch` instead, accepts only a literal `true` result, and
  otherwise falls back to the context-owned highway and then to single-player
  `window.setMastery`; `playerContexts` only gates its main-context resolution.
  Declaring a capability the host does not own is not a load
  error — the loader validates a declaration's shape, not whether the host
  implements the domain.
- What is lost without it: per-player difficulty routing reaches only the main
  player, and panels cannot be addressed individually by plugins.

### Row 7 — `e5339c0`: phrase-tier mastery mapping and `top_difficulty`

- Host surface today: `static/highway.js:74-102` (tier resolution) and
  `:2770-2783` (`top_difficulty` in `getPhrases()`), with
  `lib/song.py:715` (`collapse_arrangement_phrases`) keeping collapsed ladders
  on their original tier numbers.
- **Difficulty Ladder — optional, but a fallback here is not evidence.** The
  plugin reads `phrase.top_difficulty` when present and falls back when it is
  not. On a pre-`e5339c0` host the fallback computes from the phrase's own
  levels, while the host is selecting the rendered level by *positional* index
  across a possibly collapsed ladder — so the plugin's HUD and attempt records
  can describe a different tier than the highway is showing. Treat the
  commit as required for the feature to be *correct*, and as optional only in
  the sense that nothing throws without it.
- Fully authored ladders (levels `0..n-1`) map identically before and after, so
  the disagreement only appears where duplicate tiers were collapsed or a
  generated phrase completes early.

## Candidate baseline

`e5339c0` (2026-09-23) is the earliest commit in this repository that is a
descendant of all seven rows — verified with
`git merge-base --is-ancestor <row> e5339c0` for each. It is therefore the
cheapest single identity to name as "has everything in this table", which is why
[#102](https://github.com/get-flashbacks/feedBack/issues/102) proposes it as a
candidate baseline.

It is **not** a certified baseline. `e5339c0` is a point on a moving branch: it
is not tagged, not released, carries no `minHost` signal of its own, and nothing
here has been exercised against a historical build. If a plugin needs to name a
host to its users today, name the **row** it needs (`f7c761c` for Visual Export,
`0dcc913` for Difficulty Ladder's backend) rather than the baseline — a row is
a floor; the baseline is a moving target.

## `minHost` is metadata, not enforcement

`minHost` is read in two places, both of them pure passthroughs into API
metadata: `plugins/__init__.py:1430` and `:2151` copy it to `min_host` in
`/api/plugins`. The loader's own comment says so — "passthrough only in R0 —
enforcement is deferred to R4" — and nothing under `static/` reads it, so no
frontend check compares it against the running host and no plugin is blocked or
degraded on a mismatch. There is also no field in
`docs/plugin-manifest.schema.json` for a **feature-scoped** dependency, so a
plugin cannot say "feature A needs this host, feature B does not" in its
manifest; it has to feature-detect in code, which is what every row above does.

Practical consequences:

- A wrong or absent `minHost` costs nothing today and would mislead the first
  host that does enforce it. Prefer feature detection over a declared floor.
- Do not put a **plugin's** version in a `minHost` field. That conflation is
  exactly what Visual Export removed (it once read `1.14.8`, a Splitscreen
  version — see [#6](https://github.com/get-flashbacks/feedback-plugin-visual-export/issues/6)).
- Making `minHost` actionable is sub-issue 3 of
  [#102](https://github.com/get-flashbacks/feedBack/issues/102), not this one.

## How to check a build against a row

Given a host checkout and a row's commit:

```bash
# Does this build contain the API? Exit 0 = yes.
git merge-base --is-ancestor <commit> HEAD && echo present || echo absent

# Quickest confirmation for a running install, per row:
#   1  PYTHONPATH=lib python -c "from dlc_paths import _resolve_dlc_path"
#   2  PYTHONPATH=lib python -c "from sloppak import read_member_bytes"
#      (run from the repo root; without PYTHONPATH=lib, lib/ is not on sys.path
#      outside pytest and a capable build reads as absent)
#   3  browser console: window.feedBack.chartTransformDomain?.version === 1
#   4  the /ws/sync/{id} socket accepts a connection
#   5  browser console: typeof window.highway.renderFrameAt
#   6  browser console: typeof window.feedBack.playerContexts
#   7  browser console: window.highway.getPhrases()?.[0]?.top_difficulty
```

For the upstream/fork column, from a clone with an `upstream` remote:

```bash
gh api repos/got-feedback/feedBack/compare/<commit>...main --jq .status
# "ahead"   -> the commit is on upstream main (upstream API)
# "behind"  -> upstream knows the SHA but main does not contain it (fork-only)
```

## Corrections to #102's list

The audit behind this document confirmed #102's dependency mapping with two
corrections, and one date correction:

1. **Lyrics Karaoke does not require `0dcc913`.** At `5e9d586` it imports the
   core helper opportunistically and falls back to `safepath.safe_join` on
   `ImportError`. It is a *preferred* path, not a requirement.
2. **Splitscreen's need for `f7c761c` is optional, not required**, and the
   dependent feature is deterministic/coordinated frame rendering — not LAN
   sharing, which depends on row 4. Splitscreen feature-detects all three
   methods and degrades to its per-panel self-scheduled loop.
3. `f7c761c` is dated 2026-09-16 in #102; its committer date in UTC is
   **2026-09-17** (`2026-09-17T02:36:07Z`). Dates in this document are UTC
   committer dates.

## Related reports

- Visual Export's own history of this problem:
  [#6 — Declare the correct minimum host version](https://github.com/get-flashbacks/feedback-plugin-visual-export/issues/6)
  and
  [#7 — No working minHost/splitscreen version to record](https://github.com/get-flashbacks/feedback-plugin-visual-export/issues/7).
  #7's first two rounds concluded (correctly, at the time) that no Splitscreen
  version implemented the offline-render bridge; the bridge first shipped in
  Splitscreen 1.14.8.
- Plugins that already document their own host floors the same way, and whose
  tables this document does not duplicate: Piano
  (`README.md` → *Host: feedBack core v0.3.0-alpha.1 or newer*, plus
  `tests/host-compat.test.js` and `tools/verify-host-surface.js`) and
  Difficulty Ladder (`README.md` → host-requirements table, `PLAYER_CONTEXT.md`).

## Audit metadata

| | |
|---|---|
| Host audited | `get-flashbacks/feedBack` `d1980ff` (2026-10-02) |
| Upstream reference | `got-feedback/feedBack` `main` = `eef58c8` (read 2026-10-02) |
| Upstream tag reference | `v0.3.0-alpha.1` = `b6169af6` (2026-07-03) |
| Plugins audited | `difficulty_ladder` `9ac046a`, `lyrics-karaoke` `5e9d586`, `feedpakr` `29b0396`, `chordr` `bcf49fa`, `splitscreen` `1600e8c`, `visual_export` `a7bad12`, `piano` `fef98a2` (all default-branch HEADs, 2026-10-01/02) |
| Method | `git log`/`git show` on each commit, `git merge-base --is-ancestor` against `e5339c0`; `gh api repos/got-feedback/feedBack/compare/<sha>...main` for the upstream/fork column; read of each plugin's `routes.py` / `screen.js` / `plugin.json` on its default branch |
| Not done | Running any plugin against any historical host build; any prerelease-aware version comparison; any enforcement change |

Re-audit when any listed commit is superseded, when a plugin's default branch
moves past the audited revision, or when a release finally names a baseline —
at which point this document should collapse into a version-to-feature table
and the `minHost` discussion should move to sub-issue 3.
