# Library-scan scaling envelope

How the background library scan scales in **wall time** and **memory** with the
number of songs, measured on a repeatable harness rather than estimated. Operators
can use this to size a deployment — and `FEEDBACK_MAX_SCAN_WORKERS` in particular —
instead of guessing. Source: [#37](https://github.com/get-flashbacks/feedBack/issues/37).

The scanner reads only each pack's `manifest.yaml` (`sloppak.extract_meta` →
`load_manifest`), so scan cost is per-*song*, not per-*gigabyte*: the numbers below
are dominated by zip open + manifest parse + `MetadataDB` write. Audio size does
not enter scan cost.

## How it was measured

`scripts/scaling-envelope.py` drives the **real** scan path —
`scan.background_scan(force=True)` over the real `spawn`
`ProcessPoolExecutor` and the real `MetadataDB` — against a throwaway
`CONFIG_DIR` / `DLC_DIR` filled with N copies of an in-tree single-arrangement
sloppak. Each measurement runs in its own child process so its memory reading is
never polluted by a previous scan.

```bash
# full envelope table (default sizes 100,500,1000,2500):
PYTHONPATH=lib python3 scripts/scaling-envelope.py

# one size, JSON:
PYTHONPATH=lib python3 scripts/scaling-envelope.py --n 2500 --json

# how the worker knob moves it:
PYTHONPATH=lib python3 scripts/scaling-envelope.py --workers 1 --sizes 100,1000
```

Definitions reported per run:

- **cold scan** — first scan, every song uncached and extracted.
- **warm rescan** — a `force=True` rescan with the DB already populated (no
  extraction); this *skips* the directory-signature fast path, so it is an **upper
  bound** on a no-change rescan. The normal startup fast path
  (`scan._load_dir_signature`) is cheaper still.
- **per-song cold** — marginal cost, `(cold_N − cold_0)/N`. The N=0 run pays the
  fixed cost (process-pool boot + the four builtin-content seeds) that would
  otherwise be divided across N and flatter small libraries.
- **scan RSS delta** — main-process peak RSS (`/proc/self/status` `VmHWM`) minus
  its value before the scan. This is a **scan-time transient peak**, not the
  steady-state server footprint: the scan holds all N metadata futures in memory at
  once (see Findings). VmHWM never falls, so it is a high-water mark.
- **child peak RSS** — `RUSAGE_CHILDREN.ru_maxrss`: the footprint of one extraction
  worker. Multiply by `FEEDBACK_MAX_SCAN_WORKERS` to bound the pool.
- **web_library.db** — the metadata cache, main file + `-wal` sidecar.

## Host

| | |
|---|---|
| Host | 2 vCPU AMD EPYC, 8.6 GiB RAM, Linux |
| Python | 3.13.5 |
| Revision | `ff8984a` (fork `main`, 2026-10-17) |
| Workers | default = one per core (2) |
| Sample pack | `docs/benchmarks/note_detect_v1/note_detect_benchmark_v1.sloppak` (28,014 B; 1 arrangement, 1 stem) |

## Results — default workers (2)

| N songs | library (MB) | cold scan (s) | warm rescan (s) | per-song cold (ms) | scan RSS delta (MB) | child peak RSS (MB) | web_library.db (KB) |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 0.00 | 0.294 | 0.002 | — | 0.6 | 54.2 | 885.2 |
| 100 | 2.80 | 0.546 | 0.028 | 2.52 | 1.4 | 54.5 | 4339.5 |
| 500 | 14.01 | 1.576 | 0.049 | 2.57 | 4.5 | 55.0 | 4643.8 |
| 1000 | 28.01 | 2.638 | 0.088 | 2.34 | 8.2 | 55.4 | 4927.8 |
| 2500 | 70.03 | 7.073 | 0.257 | 2.71 | 19.3 | 56.9 | 5811.8 |

Fixed overhead at N=0 (four builtin packs + pool boot): **cold 0.29 s, 0.6 MB**.
Run-to-run spread on this shared host is roughly ±10–15% on the cold totals (the
2500-song cold scan measured 6.6–7.1 s across runs) and the marginal per-song cost
lands in **~2.3–3.0 ms/song**; treat the slope, not a single cell, as the result.

## Results — single worker (`FEEDBACK_MAX_SCAN_WORKERS=1`)

| N songs | cold scan (s) | warm rescan (s) | per-song cold (ms) | scan RSS delta (MB) | child peak RSS (MB) |
|---:|---:|---:|---:|---:|---:|
| 0 | 0.213 | 0.004 | — | 0.7 | 54.2 |
| 100 | 0.597 | 0.019 | 3.84 | 1.4 | 54.4 |
| 1000 | 4.136 | 0.247 | 3.92 | 8.2 | 55.4 |

Two workers cut the per-song cold cost from ~3.9 ms to ~2.7 ms — about **1.4×**,
not 2×. The scan's per-song work is partly main-thread serialized (the
`meta_db.put()` write, `_relpath`, and future dispatch in `background_scan`), so
past a couple of workers the pool stops being the bottleneck. Expect diminishing
returns on high-core hosts; the workers remain the memory lever, not a linear
speed knob.

## Findings

- **Cold scan scales linearly** at ~**2.7 ms/song** on the 2-vCPU host above
  (≈ 3.9 ms/song single-worker). Extrapolated from that slope — these rows were
  not measured directly:

  | N songs | cold scan | warm rescan | scan RSS peak | web_library.db |
  |---:|---:|---:|---:|---:|
  | 10,000 | ~27 s | ~0.9 s | ~75 MB | ~20 MB |
  | 25,000 | ~68 s | ~2.3 s | ~190 MB | ~50 MB |
  | 50,000 | ~135 s | ~4.6 s | ~375 MB | ~100 MB |

- **Warm rescans are ~25–30× cheaper** than the cold scan — the DB cache is the
  whole point. A no-change startup on a settled library is cheaper again via the
  directory-signature fast path (a handful of directory stats, no listing).
- **Main-process memory grows ~7.5 KB/song during the scan**, on top of the DB's
  ~2 KB/song on disk. This is transient: `background_scan` holds the full
  `to_scan` list and a `futures` dict of N pending `Future`s while the pool
  drains, so peak RSS rises with N even though the metadata itself lives in
  SQLite. A very large first import is the memory-heavy moment; steady-state
  serving is far lower.
- **Each extraction worker costs ~55 MB.** The pool is the dominant memory knob:
  a 50 k-song cold scan at 2 workers peaks around (2 × 55 MB) + the transient
  main-process growth above. Cap it with `FEEDBACK_MAX_SCAN_WORKERS` (set by the
  Desktop launcher on low-RAM machines) or the legacy `SCAN_MAX_WORKERS` on
  Docker/bare installs.
- **The metadata cache grows ~2 KB/song** (main file + WAL). Budget ~100 MB of
  `CONFIG_DIR` disk for a 50 k-song library; SQLite + WAL, no compaction needed.

## Caveats

- **Synthetic library.** N copies of one small single-arrangement sloppak. A pack
  with a much larger manifest (many arrangements/stems) costs more per song; the
  scan reads the whole manifest, so its size is the per-song variable.
- **This measures the scan only.** Serving the library (`/api/library`, art,
  playback) has its own envelope — see [perf-baseline.md](perf-baseline.md) for
  server latency and boot numbers.
- **Host-specific.** Wall times scale with CPU; the per-worker ~55 MB footprint is
  the interpreter + `scan_worker` import (roughly host-independent), and the DB
  growth is data-shape-dependent. The harness normalizes `ru_maxrss` units, which
  are KiB on Linux but bytes on macOS/BSD, so the off-Linux fallback isn't ~1024×
  off.
- Absolute times are single-host, single-run; the *slope* (per-song cost) is the
  transferable number. Re-run on your target hardware before sizing.

## Reproducing / re-baselining

Re-run `scripts/scaling-envelope.py` after any change to `lib/scan.py`,
`lib/scan_worker.py`, `lib/metadata_db.py`, or the manifest extraction path, and
update the tables above (host + revision row included). The harness uses only the
temp dirs it creates and needs no network.
