#!/usr/bin/env python3
"""Scaling-envelope harness for the library scan (feedBack#37).

Measures how the background metadata scan scales in **wall time** and **memory**
as a function of library size (N songs), so an operator can size a deployment
instead of guessing. The numbers produced here are what `docs/scaling-envelope.md`
records.

It drives the real production scan path — `scan.background_scan(force=True)` over
the real `spawn` `ProcessPoolExecutor` and the real `MetadataDB` — against a
synthetic library of N single-arrangement `.sloppak` packs, in a throwaway
`CONFIG_DIR` / `DLC_DIR`. (The scanner reads only each pack's `manifest.yaml`, so
the in-tree benchmark pack is a faithful per-song sample; pack audio size does not
enter scan cost.)

Usage
-----
    # one size, JSON (used by the matrix driver, but handy on its own):
    PYTHONPATH=lib python3 scripts/scaling-envelope.py --n 500 --json

    # full envelope table over the default sizes:
    PYTHONPATH=lib python3 scripts/scaling-envelope.py

    # custom sizes / worker count / pack:
    PYTHONPATH=lib python3 scripts/scaling-envelope.py \\
        --sizes 100,500,1000,2500 --workers 4

`--workers` sets FEEDBACK_MAX_SCAN_WORKERS for the child (the production knob);
default 0 means "one per core", matching an untuned install.

Nothing here touches a real library: every run uses a fresh temp dir, and the
temp dir is removed on exit. Network: none. Run from the repo root.
"""

from __future__ import annotations

import argparse
import json
import os
import resource
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PACK = (
    REPO_ROOT
    / "docs"
    / "benchmarks"
    / "note_detect_v1"
    / "note_detect_benchmark_v1.sloppak"
)
PACK_SUFFIXES = (".sloppak", ".feedpak")


def _ru_maxrss_to_kb(value: int) -> int:
    """Normalize `resource.getrusage().ru_maxrss` to KiB.

    Python documents `ru_maxrss` as KiB on Linux but **bytes** on macOS/BSD, so
    the raw value would over-report by ~1024x off-Linux."""
    return value // 1024 if sys.platform == "darwin" else value


def _peak_rss_kb() -> int:
    """Peak resident set size of this process, in KB.

    Linux reads `/proc/self/status` `VmHWM`; elsewhere it falls back to
    `RUSAGE_SELF.ru_maxrss`, normalized to KB (see `_ru_maxrss_to_kb`). VmHWM
    is the high-water mark for the whole process, so it includes the `server`
    import; the matrix driver reports the per-run `rss_scan_delta_kb`
    (`rss_after_cold - rss_before`) **raw** — only the per-song *time* is
    baselined against the N=0 run, not the RSS column."""
    try:
        with open("/proc/self/status", "r", encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("VmHWM:"):
                    return int(line.split()[1])
    except OSError:
        pass
    return _ru_maxrss_to_kb(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)


def _child_peak_rss_kb() -> int:
    """Peak RSS of terminated child processes, in KB.

    `RUSAGE_CHILDREN.ru_maxrss` is KiB on Linux and bytes on macOS/BSD, so it is
    normalized (see `_ru_maxrss_to_kb`). The scan pool's workers are `spawn`
    children that exit when the executor closes, so this is the peak memory of a
    single extraction worker — the per-worker footprint operators need for
    `FEEDBACK_MAX_SCAN_WORKERS` sizing."""
    return _ru_maxrss_to_kb(resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss)


def _make_library(pack: Path, n: int, dlc: Path) -> int:
    """Copy `pack` into `dlc` under N distinct names. Returns bytes written."""
    total = 0
    for i in range(n):
        dest = dlc / f"envelope-song-{i:06d}.feedpak"
        shutil.copyfile(pack, dest)
        total += dest.stat().st_size
    return total


def run_one(n: int, workers: int, pack: Path, json_out: bool) -> dict:
    # A single measurement runs the real scan in THIS process; callers wanting
    # several sizes should use the matrix driver (which spawns one child per
    # size so the memory reading is never polluted by a previous scan).
    if workers > 0:
        os.environ["FEEDBACK_MAX_SCAN_WORKERS"] = str(workers)

    tmp = Path(tempfile.mkdtemp(prefix="feedback-scaling-"))
    config_dir = tmp / "config"
    dlc_dir = tmp / "dlc"
    try:
        config_dir.mkdir()
        dlc_dir.mkdir()
        os.environ["CONFIG_DIR"] = str(config_dir)
        os.environ["DLC_DIR"] = str(dlc_dir)
        # The scanner's INFO logs go to stdout (lib/logging_setup.py); quiet them
        # unless the caller asked otherwise so `--json` reads cleanly. Warnings
        # (e.g. a failed extraction) still surface.
        os.environ.setdefault("LOG_LEVEL", "WARNING")

        written = _make_library(pack, n, dlc_dir)

        # Make the repo root + lib importable even when this file is run directly
        # (a direct `python scripts/scaling-envelope.py --n N` does not put the repo
        # root on sys.path the way `PYTHONPATH=lib` alone does).
        for p in (str(REPO_ROOT / "lib"), str(REPO_ROOT)):
            if p not in sys.path:
                sys.path.insert(0, p)

        # Import AFTER the env is set: server derives CONFIG_DIR/DLC_DIR and
        # constructs MetadataDB at import time, and publishes the appstate seams the
        # scan reads.
        import server  # noqa: F401  (import side effects are the point)
        import scan

        rss_before = _peak_rss_kb()

        # COLD: the first scan, every song uncached and extracted.
        t0 = time.perf_counter()
        scan.background_scan(force=True)
        cold_s = time.perf_counter() - t0
        rss_after_cold = _peak_rss_kb()
        rows_after_cold = server.meta_db.count()

        # WARM: a forced rescan with the DB already populated — the cost an
        # operator pays on every restart once the library is indexed.
        t0 = time.perf_counter()
        scan.background_scan(force=True)
        warm_s = time.perf_counter() - t0
        rss_after_warm = _peak_rss_kb()
        child_peak_rss_kb = _child_peak_rss_kb()

        # `web_library.db` is WAL-mode, so the main file alone understates the
        # on-disk cache — count the -wal sidecar too.
        db_path = config_dir / "web_library.db"
        db_bytes = sum(
            p.stat().st_size
            for p in (db_path, Path(str(db_path) + "-wal"))
            if p.exists()
        )
        result = {
            "n": n,
            "workers": workers or (os.cpu_count() or 1),
            "pack_bytes": pack.stat().st_size,
            "library_bytes": written,
            "rows": rows_after_cold,
            "cold_s": round(cold_s, 4),
            "warm_s": round(warm_s, 4),
            # Gross cold/N — includes the fixed N=0 overhead, so it overstates the
            # per-song cost at small N. The matrix driver reports the marginal
            # (cold_N − cold_0)/N instead.
            "gross_per_song_ms": round(cold_s * 1000.0 / n, 3) if n else None,
            "rss_before_kb": rss_before,
            "rss_after_cold_kb": rss_after_cold,
            "rss_after_warm_kb": rss_after_warm,
            "rss_scan_delta_kb": rss_after_cold - rss_before,
            "child_peak_rss_kb": child_peak_rss_kb,
            "db_bytes": db_bytes,
        }
    finally:
        # The whole point of the throwaway dir: never leave N pack copies behind,
        # even if the import, the scan, or the library build raises.
        shutil.rmtree(tmp, ignore_errors=True)

    if json_out:
        print(json.dumps(result))
    else:
        print(
            f"N={n:>5}  cold={cold_s:7.3f}s  warm={warm_s:6.3f}s  "
            f"gross-per-song={result['gross_per_song_ms']}ms  "
            f"RSS delta={result['rss_scan_delta_kb']/1024:6.1f}MB  "
            f"child-peak={child_peak_rss_kb/1024:6.1f}MB  "
            f"db={db_bytes/1024:7.1f}KB",
            file=sys.stderr,
        )
    return result


def _run_child(n: int, workers: int, pack: Path, timeout: int = 900) -> dict:
    cmd = [
        sys.executable,
        str(Path(__file__).resolve()),
        "--n",
        str(n),
        "--pack",
        str(pack),
        "--workers",
        str(workers),
        "--json",
    ]
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(
        filter(None, [str(REPO_ROOT), str(REPO_ROOT / "lib"), env.get("PYTHONPATH", "")])
    )
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise SystemExit(
            f"measurement for N={n} exceeded {timeout}s — a pool worker may be "
            f"deadlocked or N is too large for this host"
        )
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        raise SystemExit(f"measurement for N={n} failed (exit {proc.returncode})")

    # The child prints its JSON as the last line of stdout (INFO logs, if any,
    # precede it). Guard against a child that exits 0 with nothing parseable
    # rather than raising a bare IndexError/JSONDecodeError.
    lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
    if not lines:
        sys.stderr.write(proc.stderr[-2000:])
        raise SystemExit(f"measurement for N={n} produced no output")
    try:
        return json.loads(lines[-1])
    except json.JSONDecodeError as exc:
        sys.stderr.write(proc.stdout[-2000:])
        raise SystemExit(f"measurement for N={n} emitted unparseable output: {exc}")


def _fmt_mb(kb: int) -> str:
    return f"{kb / 1024.0:.1f}"


def run_matrix(sizes: list[int], workers: int, pack: Path, out: Path | None) -> None:
    # N=0 first: the fixed cost of the builtin-content seeds + the pool, which
    # the per-size rows subtract so the slope is the per-song cost.
    baseline = _run_child(0, workers, pack)
    rows = [baseline] + [_run_child(n, workers, pack) for n in sizes]

    lines: list[str] = []
    lines.append(f"# Scan scaling envelope (synthetic library, {pack.name})")
    lines.append("")
    lines.append(
        f"Host: {os.cpu_count()} logical cores | workers: "
        f"{baseline['workers']} | pack: {pack.name} "
        f"({pack.stat().st_size} B)"
    )
    lines.append("")
    lines.append(
        "| N songs | library (MB) | cold scan (s) | warm rescan (s) | "
        "per-song cold (ms) | scan RSS delta (MB) | child peak RSS (MB) | "
        "web_library.db (KB) |"
    )
    lines.append("|---:|---:|---:|---:|---:|---:|---:|---:|")
    for r in rows:
        # Marginal per-song cost is (cold_N − cold_0)/N: the N=0 run pays the
        # fixed cost (pool boot + the four builtin seeds) that would otherwise
        # be divided across N and flatter small libraries.
        if r["n"]:
            per = (r["cold_s"] - baseline["cold_s"]) * 1000.0 / r["n"]
            per_s = f"{per:.2f}"
        else:
            per_s = "—"
        lines.append(
            f"| {r['n']} | {r['library_bytes'] / 1e6:.2f} | {r['cold_s']:.3f} | "
            f"{r['warm_s']:.3f} | {per_s} | "
            f"{_fmt_mb(r['rss_scan_delta_kb'])} | {_fmt_mb(r['child_peak_rss_kb'])} | "
            f"{r['db_bytes'] / 1024.0:.1f} |"
        )
    lines.append("")
    lines.append(
        f"Fixed overhead at N=0 (builtin seeds + process pool): "
        f"cold {baseline['cold_s']:.3f}s, RSS {_fmt_mb(baseline['rss_scan_delta_kb'])} MB."
    )
    text = "\n".join(lines)
    print(text)
    if out:
        out.write_text(text + "\n", encoding="utf-8")
        print(f"\nwrote {out}", file=sys.stderr)


def _parse_sizes(raw: str) -> list[int]:
    """Parse `--sizes` into a non-empty list of positive ints, or raise ValueError."""
    sizes: list[int] = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            value = int(part)
        except ValueError:
            raise ValueError(f"{part!r} is not an integer") from None
        if value <= 0:
            raise ValueError(f"sizes must be positive, got {value}")
        sizes.append(value)
    if not sizes:
        raise ValueError("no sizes given")
    return sizes


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--n", type=int, default=None, help="single library size to measure")
    ap.add_argument(
        "--sizes",
        default="100,500,1000,2500",
        help="comma-separated sizes for the matrix run (default 100,500,1000,2500)",
    )
    ap.add_argument(
        "--workers",
        type=int,
        default=0,
        help="FEEDBACK_MAX_SCAN_WORKERS for the scan (0 = one per core)",
    )
    ap.add_argument("--pack", type=Path, default=DEFAULT_PACK, help="source .sloppak to copy")
    ap.add_argument("--json", action="store_true", help="emit one JSON object per run")
    ap.add_argument("--out", type=Path, default=None, help="write the matrix markdown here")
    args = ap.parse_args(argv)

    if not args.pack.is_file():
        ap.error(f"pack is not a file: {args.pack}")
    # A non-pack file would copy fine but be ignored by the scanner (suffix not
    # in SONG_EXTS), yielding a valid-looking rows=0 row instead of an error.
    if args.pack.suffix.lower() not in PACK_SUFFIXES:
        ap.error(f"pack must be a {PACK_SUFFIXES[0]} or {PACK_SUFFIXES[1]} file: {args.pack}")

    if args.n is not None:
        if args.n < 0:
            ap.error(f"--n must be >= 0, got {args.n}")
        run_one(args.n, args.workers, args.pack, args.json)
        return 0

    try:
        sizes = _parse_sizes(args.sizes)
    except ValueError as exc:
        ap.error(f"--sizes: {exc}")

    # Create the output parent up front: `--out` is written only after the whole
    # (minutes-long) matrix has run, so an invalid path discovered there would
    # discard the run.
    if args.out is not None:
        args.out.parent.mkdir(parents=True, exist_ok=True)

    run_matrix(sizes, args.workers, args.pack, args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
