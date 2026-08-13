# FeedBack

A self-hosted web app for browsing, playing, and practicing interactive music
notation — a scrolling note highway, standard notation, synced lyrics, and live
note detection from your instrument, all running on hardware you own.

Charts come from importing Guitar Pro (GP3–GP8) or MusicXML, or from authoring
in the [Song Editor plugin](https://github.com/got-feedback/feedBack-plugin-editor).
FeedBack stores them in its own open, hand-editable package format.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

---

## Quick start

FeedBack ships as a Docker container.

```bash
git clone https://github.com/get-flashbacks/feedBack.git
cd feedBack
LIBRARY_PATH=/path/to/your/songs docker compose up -d
```

Open <http://localhost:8000>.

`LIBRARY_PATH` points at the folder holding your songs; it defaults to
`./library` if unset. Config and caches persist in a named `feedBack-config`
volume, so they survive a container rebuild.

There is a separate `docker-compose.nas.yml` for NAS deployments, and
`build-proxmox-ct.sh` for a Proxmox container.

### Running without Docker

```bash
pip install -r requirements.txt
python main.py                          # 0.0.0.0:8000
HOST=127.0.0.1 PORT=8001 python main.py  # or pick your own
```

### Configuration

Set these in `docker-compose.yml` or the environment:

| Variable | Purpose |
| --- | --- |
| `DLC_DIR` | Song library folder inside the container (default `/dlc`) |
| `CONFIG_DIR` | Persistent config + cache. `/config` inside the container; on bare metal it defaults to `~/.local/share/feedback` |
| `LOG_LEVEL` | `DEBUG` \| `INFO` \| `WARNING` \| `ERROR` (default `INFO`) |
| `LOG_FORMAT` | `json` \| `text` (default `text`, coloured console) |
| `APP_SOURCE_URL` | Overrides the Settings → About source link |
| `APP_LICENSE_URL` | Overrides the licence link — set this explicitly if you host on a non-GitHub forge |

---

## Song formats

**Loose folder** — a directory of arrangement XML plus an audio file, with an
optional `manifest.json` and album art. Played directly, no import step.

**Sloppak** — FeedBack's own package format, and the preferred one for new
work. It exists interchangeably as a `.sloppak` zip (for distribution) or a
`.sloppak/` directory (for authoring), holding a YAML manifest, per-arrangement
note data, audio stems, cover art, and syllable-level lyrics.

The format itself is specified outside this repo, in
[got-feedback/feedpak-spec](https://github.com/got-feedback/feedpak-spec) —
published there as **feedpak**; the same on-disk format this codebase still
calls **sloppak** internally. **The spec is the authority: a new manifest key
is not part of the format until it lands there.** CI enforces this, and there
is no in-repo bypass. See [docs/sloppak-spec.md](docs/sloppak-spec.md) for the
local code map and [docs/feedpak-spec-gate.md](docs/feedpak-spec-gate.md) for
how the gate works.

---

## Plugins

Plugins are the main extension point, and most of FeedBack's features are built
as one. A plugin lives in `plugins/<id>/` with a `plugin.json` manifest and can
contribute any mix of frontend screen, backend routes, and settings panel.

> Name the directory to match the manifest's `id` (case-sensitive). That
> pairing is what marks a plugin as a bundled core one for duplicate
> resolution — it is *not* a discovery requirement, since the loader registers
> plugins by their manifest `id` whatever the folder is called. A plugin that
> genuinely won't load is usually missing `plugin.json`, has a manifest that
> fails to parse, or has an `id` that is absent, empty, or not a string.

A few of the things a plugin can do:

- **Replace the highway renderer** — declare `"type": "visualization"` and
  export a `window.feedBackViz_<id>` factory. Works in the main player and
  per-panel under split screen.
- **Layer an overlay** on top of whichever renderer is active — fretboard
  diagrams, chord labels, practice feedback.
- **Score playing** and feed per-note judgments back so any renderer can light
  up the gems.
- **Register a mixer fader**, keyboard shortcuts, a library source, or a
  detachable pane the user can pop into its own window.

Start with [feedBack-plugin-template](https://github.com/get-flashbacks/feedBack-plugin-template).
The contracts are documented in [CLAUDE.md](CLAUDE.md), with deeper guides in
[docs/](docs/) — see [plugin-v3-ui.md](docs/plugin-v3-ui.md),
[plugin-styles.md](docs/plugin-styles.md),
[plugin-modules.md](docs/plugin-modules.md),
[plugin-panes.md](docs/plugin-panes.md), and
[capability-recipes.md](docs/capability-recipes.md).

---

## Development

```bash
pip install -r requirements.txt -r requirements-test.txt
pytest                        # Python suite
npm run test:js               # JS unit tests
npm test                      # Playwright end-to-end
npm run lint                  # ESLint
bash scripts/build-tailwind.sh  # regenerate static/tailwind.min.css
```

Tailwind is served as a **prebuilt** stylesheet, never the Play CDN — the CDN's
runtime JIT rescanned the DOM on the main thread and cost ~26% of frames. CI
rebuilds and diffs the committed CSS, so run the build script and commit the
result when you add new classes.

`VERSION` at the repo root is the single source of truth for the version, and
is synced automatically when a desktop release is cut. `GET /api/version`
serves it.

---

## Contributing

Please read [CONTRIBUTING.md](CONTRIBUTING.md) first. Two things to know up
front:

- **Every commit needs a DCO sign-off** (`git commit -s`).
- **Never push directly to `main`** — branch, then open a PR.

Curated plugins should be AGPL-3.0 or AGPL-compatible (MIT, BSD, Apache-2.0).

---

## License

[AGPL-3.0-only](LICENSE). Contributions are inbound = outbound under the same
terms.
