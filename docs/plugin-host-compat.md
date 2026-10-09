# Host compatibility checks — required vs optional (plugin convention)

How a plugin decides what a host (`feedBack`) build offers, so that a missing
**optional** API disables only the feature that needs it and never the plugin.
This is sub-issue 2/5 of [#102](https://github.com/get-flashbacks/feedBack/issues/102);
it defines the *convention* plugins use. The companion matrix —
[`docs/compatibility.md`](compatibility.md) — says *which* commit provides each
API and classifies it required vs optional per plugin; this document says *how*
to probe it at runtime.

Two things are deliberately out of scope here: making `minHost` actionable and
enforcing anything at load time are sub-issue 3/5's material, not a convention's.

## The three rules

1. **Probe at the call site, one predicate per feature.** Every host API a
   plugin touches has exactly one boolean predicate that tests the *exact
   surface the feature uses* — a `typeof` for functions, a property (plus
   `version`) for objects, an import/`hasattr` for backend modules, a data-shape
   check for return values. Never compare version strings, never parse
   `VERSION`, never `git describe` at runtime.
2. **A missing optional API disables only its feature.** The feature's entry
   point reports itself unavailable and returns; the plugin keeps loading and
   everything else keeps working. Never `throw`, never `return null` from
   `setup()`, never blanket-disable the plugin.
3. **One named warning per unavailable feature.** The warning names the plugin,
   the feature, and the missing requirement — the API plus the exact commit from
   the matrix. It fires once per session. This is what turns a confusing "the
   button does nothing" into "the host build predates `f7c761c`, so offline
   export is unavailable".

Rule 2 has the corollary that guards the whole system: **an optional feature
must never raise the plugin's basic-mode floor.** The plugin's basic mode must
run against the oldest host the plugin claims to support (Piano documents
`0.3.0-alpha.1`; difficulty_ladder documents its host-requirements table in its
README). A fork-only API (rows 5–7 in the matrix, e.g. `renderFrameAt` or
`playerContexts`) can only gate the feature that uses it, never the plugin's
load or its core functions.

## What "required" vs "optional" decides

The matrix classifies each (API, plugin) pair. The classification maps onto the
convention like this:

| Classification | Means | Plugin behavior when the probe fails |
|---|---|---|
| **Required for feature X** | Feature X *cannot* exist on a host without the API | Feature X is unavailable: its entry point reports the missing requirement (named warning) and the rest of the plugin keeps working. A plugin whose *entire* value is feature X is free to treat the whole plugin as unusable — but failing pollutes the host, so still report *why*. |
| **Optional for feature X** | Feature X exists and degrades; the plugin has a fallback path | Run the fallback. Emit the named warning once (`console.warn`, or `context["log"].warning` from `routes.py`) and continue. Nothing else changes. |

The important, easy-to-get-wrong case is the second one. A fallback that
produces subtly wrong output is still "optional" for *loading* purposes — but
if the fallback cannot be proven correct (matrix row 7's `top_difficulty`
fallback), the probe should be treated as "optional but load-bearing":
keep the feature but surface the degradation loudly enough that a user or a
diagnostics bundle can tell the difference.

## Probes for the matrix

All seven rows of the `docs/compatibility.md` matrix, as plugin-side probes.
Each probe is one predicate per feature, exact-surface only.

| # | Feature | Probe | Missing requirement to name | Required / optional |
|---|---|---|---|---|
| 1 | DLC-resolved song paths (`lib/dlc_paths._resolve_dlc_path`) | guarded import in `routes.py` | `lib/dlc_paths` (commit `0dcc913`) | Required for difficulty_ladder generation; optional for lyrics_karaoke (falls back to `safepath.safe_join`) |
| 2 | `sloppak.read_member_bytes` | `hasattr(sloppak_mod, "read_member_bytes")` *after* a guarded module import | `sloppak.read_member_bytes` (commit `d876ded`) | Required at call time for pack-reuse / upgrade / dedup |
| 3 | `chart-transform` capability | `window.feedBack.chartTransformDomain?.version === 1` | `chart-transform` domain (commit `05be9eb`) | Optional for chordr's enrichment tier |
| 4 | `/ws/sync/{session_id}` relay | connect-probe (below) | `/ws/sync/{session_id}` relay (commit `03e1c1d`) | Optional for splitscreen LAN sharing |
| 5a | Co-ordinated frame driver | `typeof highway.setExternalFrameDriver` + `typeof highway.renderFrame` | `setExternalFrameDriver`/`renderFrame` (commit `f7c761c`) | Optional for splitscreen's coordinated frames |
| 5b | Deterministic offline frames | `typeof highway.renderFrameAt` | `renderFrameAt` (commit `f7c761c`) | Required for visual_export |
| 6 | Player contexts | `window.feedBack.playerContexts.version === 1` | `playerContexts` (commit `7633211`) | Optional everywhere (always a fallback path) |
| 7 | Phrase-tier numbers | `getPhrases()` data shape (below) | `getPhrases().top_difficulty` (commit `e5339c0`) | Optional but load-bearing for difficulty_ladder's correctness |

### Canonical JavaScript pattern

```js
// plugins/<id>/screen.js — inside your IIFE.
const HOST_FEATURES = {
    // Only the features THIS plugin uses. `has()` is the one predicate.
    // Never register a data-shape probe (row 7) with `has()` that this cache
    // would freeze before `ready` — probe those at the call site instead.
    offlineFrames: {
        label: 'Deterministic offline export frames',
        requirement: 'highway.renderFrameAt (f7c761c, fork-only)',
        has() {
            return typeof (window.highway && window.highway.renderFrameAt) === 'function';
        },
    },
    playerContexts: {
        label: 'Per-player identity contexts',
        requirement: 'window.feedBack.playerContexts (7633211, fork-only)',
        has() {
            const pc = window.feedBack && window.feedBack.playerContexts;
            return !!(pc && pc.version === 1);
        },
    },
};

const _warnedOnce = new Set();

// Truthy -> the feature is available. Never throw.
function hostFeature(feature) {
    const probe = HOST_FEATURES[feature];
    if (!probe || !probe.has) return false;
    if (probe._cached === undefined) probe._cached = probe.has() === true;
    return probe._cached;
}

// Claim a feature for use. If it is unavailable, warns ONCE with a message
// naming the plugin, the feature and the missing requirement, then returns
// false so the caller can degrade just that feature.
function assumeHostFeature(feature) {
    if (hostFeature(feature)) return true;
    const probe = HOST_FEATURES[feature] || {};
    if (!_warnedOnce.has(feature)) {
        _warnedOnce.add(feature);
        console.warn(
            `[<plugin_id>] ${probe.label || feature} unavailable: this host (` +
            `${probe.requirement || 'unknown requirement'}). The plugin keeps ` +
            `working; only this feature is disabled.`
        );
        if (window.feedBack && window.feedBack.diagnostics) {
            window.feedBack.diagnostics.contribute('<plugin_id>_host_compat', {
                schema: 'feedBack.host_compat.v1',
                unavailable: [{ feature, requirement: probe.requirement }],
            });
        }
    }
    return false;
}
```

The diagnostics contribution is optional but recommended — the bundle is shared
with maintainers, so the named requirement turns a support round-trip into a
one-line answer. Keep the payload small; it overwrites on repeat contributions.

### Row-by-row degradation contract

#### Row 1 — `lib/dlc_paths._resolve_dlc_path`

Python, `routes.py`. Required for difficulty_ladder's generation route;
optional for lyrics_karaoke.

```python
try:
    from dlc_paths import _resolve_dlc_path  # 0dcc913 (upstream)
except ImportError:
    _resolve_dlc_path = None
```

Required consumers: skip registering the dependent route (difficulty_ladder
generation) and warn via `context["log"]`. Optional consumers (lyrics_karaoke)
fall back to `safepath.safe_join` and never weaken containment.

#### Row 2 — `sloppak.read_member_bytes`

Python. The common mistake is importing `lib/sloppak` behind a guarded import
and assuming that is enough. A host can have the *module* and still predate
`d876ded`; probe the member:

```python
has_read_member = hasattr(sloppak_mod, "read_member_bytes")  # d876ded (upstream)
```

Degrade: fall back to your standalone zip reader (feedpakr does) or skip the
pack-reuse feature — never crash a conversion.

#### Row 3 — `chart-transform`

Declaring the capability in the manifest is *not* a probe: the loader
validates a declaration's shape, never whether the host implements the domain.
Probe the runtime domain object:

```js
function hasChartTransform() {
    const d = window.feedBack && window.feedBack.chartTransformDomain;
    return !!(d && d.version === 1);   // 05be9eb (upstream)
}
```

Degrade: `highway.getChordTemplates()` returns no generated diagrams and
`window.<plugin>.getChartTransformStatus()` reports a no-owner state. Nothing
throws.

#### Row 4 — `/ws/sync/{session_id}`

Cannot be feature-detected from a page (there is no `typeof` for a route). The
degradation pattern is a connect-probe: attempt to open the share socket, count
failures *including* a constructor that throws outright, and past a threshold
warn once + toast naming the relay and commit `03e1c1d`. splitscreen's
`screen.js` is the canonical implementation (it already does exactly this).

#### Row 5 — frame APIs

Two features, two probes, both from `f7c761c`:

```js
function hasCoordinatedFrames() {   // 5a — optional for splitscreen
    const h = window.highway;
    return !!(h && typeof h.setExternalFrameDriver === 'function'
                  && typeof h.renderFrame === 'function');
}
function hasOfflineFrames() {       // 5b — required for visual_export
    return typeof (window.highway && window.highway.renderFrameAt) === 'function';
}
```

Optional consumers degrade silently to their own rAF loop. `renderFrameAt` is
all-or-nothing with a host *bridge:* Splitscreen's bridge `renderFrameAt()`
returns `false` unless offline rendering is active (core's own method only
returns `false` pre-`ready`), so a plugin that needs split-layout export must
also check the rendering host that provides `beginOfflineRender` (splitscreen
1.14.8, commit `2301dd5`) — cite that, not the side-branch `87e3622a`.

#### Row 6 — `playerContexts`

Probe the object, not the capability declaration:

```js
const pc = window.feedBack && window.feedBack.playerContexts;
if (!(pc && pc.version === 1)) {    // 7633211 (fork-only), optional
    // warn once; fall back to the main highway / single-player path
}
```

Every current consumer guards and degrades to single-player behavior.

#### Row 7 — `getPhrases().top_difficulty`

Data-shape probe, and only *after* `ready`/at the call site (`getPhrases()`
returns `null` until phrase data has arrived):

```js
function hasPhraseTierNumbers() {
    const phrases = window.highway && window.highway.getPhrases();
    return Array.isArray(phrases) && phrases.length > 0
        && typeof phrases[0].top_difficulty === 'number';   // e5339c0 (fork-only)
}
```

Use `typeof … === 'number'`, not truthiness: an authored one-level phrase
reports `top_difficulty === 0`. This is "optional but load-bearing":
difficulty_ladder's fallback computes a tier the highway may not actually be
showing, so warn noticeably (console warning at a minimum) rather than
silently presenting output that can disagree with the rendered highway.

## Backend rule

The same convention applies to `routes.py`, using `context["log"]` for the
single named warning:

```python
def setup(app, context):
    log = context["log"]
    try:
        from dlc_paths import _resolve_dlc_path  # 0dcc913 (upstream)
    except ImportError:
        _resolve_dlc_path = None
        log.warning(
            "ladder generation unavailable: host lacks lib/dlc_paths._resolve_dlc_path "
            "(commit 0dcc913). The plugin keeps working; only this feature is disabled."
        )
```

Never `raise` from `setup()` for an optional API — that is how a missing
optional API becomes a plugin-wide outage. Prefer skipping the feature, and if
the whole plugin genuinely cannot function, fail with the named requirement in
the log rather than a bare traceback.

## Where the host does NOT help today

- `minHost` is metadata passthrough only (`plugins/__init__.py` copies it to
  `/api/plugins`); nothing under `static/` reads it, and it is not
  feature-scoped. Do not rely on it, and do not encode a *feature* floor in it —
  that is sub-issue 3/5.
- Declaring a capability domain the host does not implement is not a load error.
  The declaration is intent; the runtime probe is the domain object, an
  `inspect()`, or the outcome of a dispatched command (any non-`handled`
  outcome means "feature unavailable" — see the `practice-difficulty` recipe in
  `docs/capability-recipes.md`).

## Checklist for a plugin PR adding an optional feature

- [ ] One `has()` predicate per host API the feature touches; exact-surface
      checks only.
- [ ] Predicate probed at the call site (post-`ready` for data-shape probes),
      result cached per session.
- [ ] On failure: warn **once**, naming the plugin, the feature and the
      requirement (API + commit); disable only that feature.
- [ ] Basic mode and plugin load never depend on an optional probe.
- [ ] Backend equivalents use `context["log"].warning` and skip the feature, not
      `setup()` failure.
- [ ] The degradation is recorded in the plugin's diagnostics contribution
      (`window.feedBack.diagnostics.contribute`) when a bundle is produced.
