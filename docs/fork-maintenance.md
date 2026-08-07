# Fork Maintenance Policy

This repo (`get-flashbacks/feedBack`) is a personal downstream fork of the
canonical project, [`got-feedback/feedBack`](https://github.com/got-feedback/feedBack).
The goal of this document is to keep pulling upstream changes cheap forever,
instead of expensive once a year.

Every manual edit to a file upstream also touches is **maintenance debt**: the
next `git merge`/`git rebase` from upstream has to reconcile it by hand. This
policy exists to keep that debt near zero.

## Priority matrix

When deciding how to make a change, work top to bottom — stop at the first
row that fits:

| Priority | What it is | Example |
|---|---|---|
| **P0 — Upstream sync** | Pulling `got-feedback/feedBack:main` in, resolving conflicts | `scripts/fork-sync.sh` |
| **P1 — Hook injection** | A small, generic extension point added to core so plugin/fork logic can live outside core | 2-line event emit + a plugin file with the real logic |
| **P2 — Plugin-isolated feature** | Anything that lives entirely under `plugins/<name>/` | A new plugin directory |
| **P3 — Direct core edit** | Business logic written straight into `server.py`, `lib/`, `static/`, `Dockerfile`, etc. | Avoid; only for real upstream-worthy bug fixes |

**Rule of thumb:** if a core edit is more than a few lines of business logic
(not a hook call, not a one-line bug fix), it almost always belongs in P1 or
P2 instead.

## The four rules

1. **Hook injection over inline edits.** If a plugin needs core to do
   something it doesn't support yet, don't write the feature inside the core
   file. Add the smallest possible hook/event/extension point to core, and
   put the actual logic in the plugin. This repo already has a rich contract
   for this — see `CLAUDE.md`'s "Plugin System" and "Plugin Best Practices"
   sections (`context["log"]`, `load_sibling`, library providers, the
   `setRenderer` / overlay / note-state-provider / chart-transform-provider
   contracts, `window.feedBack.emit/on`, keyboard shortcut scopes, pane
   registration, fader registration). Reach for one of those before touching
   a core file. Real bug fixes to core (not feature logic) are the one
   legitimate exception — see the P3 note below.

2. **Segregate commits.** Every commit that touches a core path (see
   "What counts as core" below) must start its subject line with one of:
   - `core:` — a direct core edit (P3; keep it small, and prefer to also open
     it as a PR upstream, see Rule 3)
   - `hook:` — adding/expanding an extension point in core so a plugin can do
     the rest (P1)
   - `sync:` — merging/rebasing upstream changes in (P0)
   - `fix:` — a bug or security fix to core (P3; use `fix(security):` for
     security hotfixes following conventional-commit scope notation)

   Commits that touch only `plugins/**` don't need a prefix (that's the
   normal case and needs no special handling). This labeling is what lets
   you `git log --grep -E '^(core|fix)(\([^)]*\))?:'` or cherry-pick your
   minimal core diff onto a fresh upstream tag when things diverge badly.

3. **Upstream PRs retire debt.** Whenever a `core:`/`hook:`/`fix:` commit lands
   here, ask: *is this useful to anyone else running FeedBack?* If yes, open
   a PR against `got-feedback/feedBack:main` (see `CONTRIBUTING.md` for the
   DCO/licensing requirements). Once it merges upstream, your local edit
   becomes redundant on the next sync and your merge debt for that file
   drops to zero. Track open upstream PRs in commit trailers, e.g.
   `Upstream-PR: got-feedback/feedBack#1234`.

4. **Sync before you build.** Before starting new fork-only work, pull
   upstream first (`scripts/fork-sync.sh`). Small, frequent syncs (weekly)
   are far cheaper than one large one. Treat an available upstream update or
   security fix as higher priority than a new personal feature.

## What counts as "core"

Everything **except**:

```
plugins/**
docs/**
tests/**
scripts/**
specs/**
.specify/**
CHANGELOG.md
VERSION
```

That includes `server.py`, `main.py`, `lib/**`, `static/**`, `Dockerfile`,
`docker-compose*.yml`, `.github/workflows/**`, `pyproject.toml`,
`requirements*.txt`, `package.json`, etc.

## Decision tree

```
Does upstream have an update or security fix?
  -> P0: sync first (scripts/fork-sync.sh), before anything else.

Does a plugin need something from core that isn't exposed?
  -> P1: add a minimal hook/event to core (commit: "hook: ...").
     Consider a PR upstream if it's broadly useful (Rule 3).

Is it a feature/fix specific to your own workflow?
  -> P2: build it entirely inside plugins/<name>/. Zero core impact.

Tempted to edit a core file directly for convenience?
  -> P3 / avoid. If it's truly a bug fix (not new logic), it's OK, but
     label the commit "fix:" and consider sending it upstream — a real
     bug fix is exactly the kind of thing got-feedback/feedBack wants back.
```

## Enforcement

Policy that isn't checked erodes. Two mechanisms enforce this one:

- **`.github/workflows/fork-audit.yml`** — a fork-only CI workflow (does not
  touch or replace upstream's `ci.yml`/`ship-ci.yml`, to avoid creating a
  conflict in the exact file this policy is trying to keep conflict-free):
  - `core-commit-labeling` fails a PR if any commit it introduces (relative
    to the PR base) touches a core path without a `core:`/`hook:`/`sync:`/
    `fix:` prefix.
  - `upstream-drift` is advisory-only: reports how many commits behind
    `got-feedback/feedBack:main` this branch is, and warns (without failing)
    once that count crosses a threshold, as a nudge for Rule 4.
- **`scripts/fork-sync.sh`** — sets up the `upstream` remote if missing and
  fetches/reports drift, so P0 syncs are a one-command habit rather than a
  thing you have to remember how to do.

## Current state (as of the last audit)

Recorded here so the next audit has a baseline to diff against, not as a
permanent record — update or delete this section once it's stale.

- No `upstream` remote was configured in this fork as of 2026-08-02, despite
  `CLAUDE.md` documenting the `origin`/`upstream` split as the intended
  convention. `scripts/fork-sync.sh` fixes this on first run.
- Three fork-only commits existed on `main` at audit time, all direct core
  edits with no `core:`/`hook:` labeling (predating this policy, so not
  retroactively flagged by CI):
  - `830a708` — Guitar Pro strum-direction import (`lib/gp2rs.py`,
    `lib/gp2rs_gpx.py`). Real feature logic in a converter core owns; a
    reasonable upstream PR candidate under Rule 3.
  - `5b443e9` — null-check fix in `lib/routers/ws_highway.py`. A genuine bug
    fix (P3's legitimate exception) — a good candidate to send upstream.
  - `b9e7c3d` — `Dockerfile` FFmpeg asset fix. Build-only, low conflict risk,
    also a reasonable upstream PR candidate.
