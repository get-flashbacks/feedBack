#!/usr/bin/env python3
r"""Supply-chain pin gate for the FFmpeg binaries baked into the image.

The image ships a static FFmpeg downloaded at build time. Pinning only the
*host* it comes from is not pinning the *bytes*: an HTTPS transfer from
GitHub proves the download was not tampered with in flight, not that it was
the artefact a reviewer approved. With a mutable ref (`latest`) two builds of
the same commit can embed different binaries, a change in a moving executable
enters the shipped image with executable privileges while bypassing the
repository diff, and the provenance labels record only names that cannot
identify the payload.

So every download must be pinned to a retained immutable release AND
verified against a committed SHA-256 during the build, with the same values
recorded in the image labels. This gate makes those properties structural
instead of a convention:

  1. immutable-ref   — the release is a concrete dated `autobuild-*` tag, not
                       `latest` / `master-latest`, and each asset name carries
                       the concrete FFmpeg commit it was built from, not a
                       `-latest-` placeholder.
  2. hashed          — every architecture has a 64-hex SHA-256 pin.
  3. verified        — the fetcher stage runs `sha256sum -c` against the file
                       it actually downloaded, in code the shell will execute
                       (not a comment, on any continuation line), does not
                       discard the result, and hard-fails when the pin is
                       empty. A build that cannot verify must not produce an
                       image. The checks reason about the *unfolded* command,
                       because Docker joins `\` continuations before running.
  4. labelled        — the *final* stage carries `org.feedBack.ffmpeg.*`
                       LABEL instructions recording release, filenames and
                       hashes, each interpolating the build arg that was
                       verified (a literal or a `${X:-latest}` fallback can
                       drift from the pin it claims to describe).
  5. mirrored        — build-proxmox-ct.sh ships the same binary, so its pins
                       must not drift from the Dockerfile's. (Constants only:
                       that script keeps its documented `SKIP_HASH_CHECK`
                       escape hatch, which this gate does not police.)

Dev/CI tooling only: never imported on the serve or Docker path (constitution
Principle I — same category as scripts/build-tailwind.sh and
tools/check_spec_conformance.py).

Usage:
    python tools/check_docker_pins.py

Exit status is 0 only when every layer passes.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# BtbN tags its daily builds `autobuild-<YYYY>-<MM>-<DD>-<HH>-<MM>`. Its
# documented retention policy keeps the last build of each month for two
# years, the last 14 dailies, and lets `latest` float — so a month-end dated
# tag is the only shape that is both immutable and retained.
RELEASE_RE = re.compile(r"^autobuild-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}$")
# BtbN names version-pinned assets after the FFmpeg revision they were built
# from: ffmpeg-n<series>-linux{64,arm64}-gpl-<series>.tar.xz, where
# `n7.1.5-12-g1fdbca85aa` is the FFmpeg version, commits-since-tag, and
# short commit hash. Requiring that literal shape is what rejects the
# floating `ffmpeg-n7.1-latest-…` name (and the unfrozen `nN-…` master
# track, which carries no series at all).
ASSET_RE = re.compile(
    r"^ffmpeg-n\d+\.\d+\.\d+-\d+-g[0-9a-f]{6,}-linux(?:64|arm64)-gpl-\d+\.\d+\.tar\.xz$"
)
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

ARCHES = ("AMD64", "ARM64")
ARG_NAMES = (
    "FFMPEG_RELEASE",
    "FFMPEG_BUILD_AMD64",
    "FFMPEG_BUILD_ARM64",
    "FFMPEG_SHA256_AMD64",
    "FFMPEG_SHA256_ARM64",
)

FETCHER_MARKER = "ffmpeg-fetcher"
LABEL_PREFIX = "org.feedBack.ffmpeg."

# The provenance the shipped image must carry: label key -> the build arg it
# has to interpolate, so the recorded value is always the verified pin.
REQUIRED_LABELS = (
    ("release", "FFMPEG_RELEASE"),
    ("source.amd64", "FFMPEG_BUILD_AMD64"),
    ("source.arm64", "FFMPEG_BUILD_ARM64"),
    ("sha256.amd64", "FFMPEG_SHA256_AMD64"),
    ("sha256.arm64", "FFMPEG_SHA256_ARM64"),
)

# Constructs that keep the pipeline running after a failed `sha256sum -c`.
# Docker joins `\` continuations before executing, so `|| true` on the next
# physical line still swallows the failure — hence these are matched against
# the unfolded command.
_FAILURE_DISCARDS = (
    "|| true",
    "|| :",
    "|| exit 0",
    "||:",
    "set +e",
)


class Report:
    """Collects failures so one run surfaces every problem, not just the first."""

    def __init__(self) -> None:
        self.errors: list[str] = []

    def fail(self, where: str, message: str) -> None:
        self.errors.append(f"{where}: {message}")


def _split_stages(text: str) -> list[tuple[str, list[str]]]:
    """Return `(FROM line, instruction lines)` per build stage, in file order.

    Kept as an ordered list rather than a dict: the final stage is the *last*
    one, and merging every non-fetcher stage into a single bucket would let an
    earlier stage satisfy a check that is about the final image.
    """
    stages: list[tuple[str, list[str]]] = []
    for line in text.splitlines():
        # Dockerfile keywords are case-insensitive and may be indented; a gate
        # that turns red on `from … as …` would get blamed for a reformat.
        if line.lstrip().upper().startswith("FROM "):
            stages.append((line, []))
        elif stages:
            stages[-1][1].append(line)
    return stages


def _is_fetcher(from_line: str) -> bool:
    """True only for a stage whose alias is exactly `ffmpeg-fetcher`.

    Substring matching would let `AS ffmpeg-fetcher-cache` absorb every
    fetcher check, so a decoy stage could stand in for the real one.
    """
    return bool(re.search(r"\bAS\s+ffmpeg-fetcher\s*$", from_line.strip(), re.IGNORECASE))


def _stage(stages: list[tuple[str, list[str]]]) -> list[str] | None:
    for from_line, lines in stages:
        if _is_fetcher(from_line):
            return lines
    return None


def _logical(lines: list[str]) -> list[str]:
    """Unfold backslash continuations and strip shell comments.

    Docker joins a continued `RUN` into one shell command before executing it,
    so a check that reads one physical line at a time can be satisfied by a
    fragment that is really commented out or on a later continuation line.
    Unfolding first, then removing `#` comments with quote awareness, means the
    gate reasons about the command the shell actually runs.
    """
    joined: list[str] = []
    buf = ""
    for line in lines:
        body = line.rstrip()
        if body.endswith("\\"):
            buf += body[:-1] + " "
        else:
            joined.append(buf + body)
            buf = ""
    if buf:
        joined.append(buf)
    return [_strip_shell_comment(line) for line in joined]


def _strip_shell_comment(line: str) -> str:
    """Remove a trailing `#` comment, respecting quotes and backslash escapes."""
    out: list[str] = []
    quote: str | None = None
    i = 0
    while i < len(line):
        ch = line[i]
        if quote == '"' and ch == "\\" and i + 1 < len(line):
            out.append(line[i: i + 2])
            i += 2
            continue
        if quote:
            out.append(ch)
            if ch == quote:
                quote = None
        elif ch in "\"'":
            quote = ch
            out.append(ch)
        elif ch == "#":
            # Only a `#` outside quotes starts a comment; everything from here
            # on is what the shell would ignore.
            break
        else:
            out.append(ch)
        i += 1
    return "".join(out).strip()


def _run_body(lines: list[str]) -> str:
    """The executable text of one stage, continuations joined, comments gone."""
    return "\n".join(_logical(lines))


def _segments(line: str) -> list[str]:
    """Split one unfolded command into its `&&`/`||`/`;`/`|`-separated parts.

    Separators inside quotes are not separators; ignoring that can only make a
    segment *larger* than reality, so a check scoped to a segment stays sound.
    """
    parts: list[str] = []
    current: list[str] = []
    quote: str | None = None
    i = 0
    while i < len(line):
        ch = line[i]
        if quote:
            current.append(ch)
            if ch == quote:
                quote = None
        elif ch in "\"'":
            quote = ch
            current.append(ch)
        elif ch == "&" and line[i: i + 2] == "&&":
            parts.append("".join(current))
            current = []
            i += 2
            continue
        elif ch == "|" and line[i: i + 2] in ("|", "||"):
            parts.append("".join(current))
            current = []
            i += 2
            continue
        elif ch == ";":
            parts.append("".join(current))
            current = []
        else:
            current.append(ch)
        i += 1
    parts.append("".join(current))
    return parts


def _arg_defaults(lines: list[str]) -> dict[str, str]:
    """Collect `ARG NAME=value` defaults from one stage's instruction lines."""
    defaults: dict[str, str] = {}
    for line in _logical(lines):
        stripped = line.strip()
        if not re.match(r"^ARG\s+", stripped, re.IGNORECASE):
            continue
        body = re.sub(r"^ARG\s+", "", stripped, flags=re.IGNORECASE)
        if "=" not in body:
            continue
        name, _, value = body.partition("=")
        defaults[name.strip()] = value.strip()
    return defaults


def check_dockerfile(path: Path, report: Report) -> None:
    stages = _split_stages(path.read_text(encoding="utf-8"))
    fetcher_lines = _stage(stages)
    final_lines = stages[-1][1] if stages else None

    if fetcher_lines is None:
        report.fail("Dockerfile", f"no build stage named `{FETCHER_MARKER}`")
    # The fetcher is a throwaway stage, so the image that ships must be a
    # *later* one; if the fetcher is last there is nothing to carry labels.
    if not stages or _is_fetcher(stages[-1][0]):
        report.fail("Dockerfile", "no final image stage after the ffmpeg fetcher")
    if fetcher_lines is None or final_lines is None:
        return

    fetcher = _arg_defaults(fetcher_lines)
    final = _arg_defaults(final_lines)

    # (1) immutable-ref + (2) hashed, on the values that drive the download.
    absent = [name for name in ARG_NAMES if name not in fetcher]
    for name in absent:
        report.fail("Dockerfile/ffmpeg-fetcher", f"`ARG {name}` is not declared")
    if absent:
        return

    release = fetcher["FFMPEG_RELEASE"]
    if not RELEASE_RE.match(release):
        report.fail(
            "Dockerfile/ffmpeg-fetcher",
            f"FFMPEG_RELEASE={release!r} is not a dated autobuild-* tag. "
            "`latest` is a mutable ref whose assets are replaced in place; pin a "
            "month-end build, which BtbN retains for two years.",
        )

    for arch in ARCHES:
        asset = fetcher[f"FFMPEG_BUILD_{arch}"]
        if not ASSET_RE.match(asset):
            report.fail(
                "Dockerfile/ffmpeg-fetcher",
                f"FFMPEG_BUILD_{arch}={asset!r} is not a concrete "
                "`-g<commit>` tarball name; a `-latest-` segment means the "
                "asset floats.",
            )
        digest = fetcher[f"FFMPEG_SHA256_{arch}"]
        if not SHA256_RE.match(digest):
            report.fail(
                "Dockerfile/ffmpeg-fetcher",
                f"FFMPEG_SHA256_{arch}={digest!r} is not a 64-char lowercase hex "
                "SHA-256. Every download needs a non-empty expected checksum.",
            )

    # (3) verified: the pin has to actually gate the build, in real code.
    # Reason over the *unfolded, comment-stripped* command list, because that
    # is what the shell runs: Docker joins `\` continuations into one command,
    # and a `#` mid-line comments out the rest of the physical line.
    fetcher_code = _logical(fetcher_lines)
    verifying = [l for l in fetcher_code if "sha256sum -c" in l]
    if not verifying:
        report.fail(
            "Dockerfile/ffmpeg-fetcher",
            "the download is never verified — no `sha256sum -c` against the pinned hash",
        )
    else:
        for line in verifying:
            swallowed = next((p for p in _FAILURE_DISCARDS if p in line), None)
            if swallowed:
                report.fail(
                    "Dockerfile/ffmpeg-fetcher",
                    f"the `sha256sum -c` result is discarded (`{swallowed}`); a failed "
                    "check must abort the build",
                )
        # The check has to cover the artifact that was downloaded, not some
        # other file in the stage. Match within the individual command, so an
        # unrelated `rm -rf <path>` later in the same RUN cannot vouch for it.
        downloaded = {
            m.group(1)
            for line in fetcher_code
            for m in re.finditer(r"-o\s+(\S+)", line)
        }
        checked = {
            path.strip("\"'")
            for line in verifying
            for segment in _segments(line)
            if "sha256sum -c" in segment
            for path in downloaded
            if path in segment
        }
        if downloaded and checked != downloaded:
            report.fail(
                "Dockerfile/ffmpeg-fetcher",
                f"`sha256sum -c` does not check the downloaded tarball "
                f"({', '.join(sorted(downloaded))}); it is fetched unverified",
            )
    if not any(re.search(r'-z\s+"?\$\{?FFMPEG_SHA256', l) for l in fetcher_code):
        report.fail(
            "Dockerfile/ffmpeg-fetcher",
            "no empty-checksum guard. A build must fail outright when the expected "
            "SHA-256 is missing rather than skipping verification.",
        )

    # (4) labelled: the final stage must advertise exactly what was verified.
    for name in ARG_NAMES:
        if name not in final:
            report.fail(
                "Dockerfile/final",
                f"`ARG {name}` is not re-declared, so the labels would lose it "
                "(ARG values do not cross stage boundaries)",
            )
        elif final[name] != fetcher[name]:
            report.fail(
                "Dockerfile/final",
                f"{name}={final[name]!r} disagrees with the fetcher's "
                f"{fetcher[name]!r}; the label would not describe the verified binary",
            )

    # Provenance must be real `LABEL` instructions in the final stage — a
    # `key=value` line inside a `RUN` records nothing, so accepting one would
    # leave the shipped image with no labels at all. Continuations are unfolded
    # first, so a multi-key LABEL is one logical line, and comments are
    # stripped so prose cannot stand in for an instruction.
    label_text = "\n".join(
        line for line in _logical(final_lines) if re.match(r"^LABEL\b", line.strip(), re.I)
    )
    # `$` and `{}` are required, and the value must end there: this rejects both
    # a hardcoded literal and a `${FFMPEG_RELEASE:-latest}` fallback to the
    # floating ref that this change exists to remove.
    interpolated = {
        m.group("key"): m.group("arg")
        for m in re.finditer(
            rf"(?:^|\s)(?P<key>{re.escape(LABEL_PREFIX)}[\w.]+)"
            rf"\s*=\s*\"?\$\{{(?P<arg>[A-Z0-9_]+)\}}\"?",
            label_text,
        )
    }
    declared = set(
        re.findall(rf"(?:^|\s)({re.escape(LABEL_PREFIX)}[\w.]+)\s*=", label_text)
    )
    for key, arg in REQUIRED_LABELS:
        full = f"{LABEL_PREFIX}{key}"
        if interpolated.get(full) == arg:
            continue
        if full in declared:
            report.fail(
                "Dockerfile/final",
                f"`{full}` does not interpolate `${{{arg}}}`. A provenance label "
                "must record the pinned value at build time, not a literal that "
                "can drift from what was verified.",
            )
        else:
            report.fail(
                "Dockerfile/final",
                f"missing `LABEL {full}=...${{{arg}}}`. Provenance that cannot "
                "identify the shipped bytes is not provenance.",
            )


def check_proxmox_script(path: Path, dockerfile: Path, report: Report) -> None:
    """(5) mirrored — the CT builder ships the same binary."""
    text = path.read_text(encoding="utf-8")
    shell = {
        name: value
        for name, value in re.findall(
            r"^(FFMPEG_[A-Z0-9_]+)=\"?([^\"\s]+)\"?\s*(?:#.*)?$", text, re.MULTILINE
        )
    }
    stages = _split_stages(dockerfile.read_text(encoding="utf-8"))
    fetcher_lines = _stage(stages) or []
    expected = _arg_defaults(fetcher_lines)

    for name in ARG_NAMES:
        if name not in shell:
            report.fail(path.name, f"{name} is not pinned here but the Dockerfile pins it")
        elif shell[name] != expected.get(name):
            report.fail(
                path.name,
                f"{name}={shell[name]!r} disagrees with the Dockerfile's "
                f"{expected.get(name)!r}; the two images would ship different binaries",
            )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--dockerfile",
        type=Path,
        default=Path("Dockerfile"),
        help="path to the Dockerfile (default: ./Dockerfile)",
    )
    parser.add_argument(
        "--proxmox-script",
        type=Path,
        default=Path("build-proxmox-ct.sh"),
        help="path to the Proxmox CT builder (default: ./build-proxmox-ct.sh)",
    )
    args = parser.parse_args(argv)

    report = Report()
    check_dockerfile(args.dockerfile, report)
    if args.proxmox_script.is_file():
        check_proxmox_script(args.proxmox_script, args.dockerfile, report)
    else:
        report.fail(args.proxmox_script.name, "file not found")

    for error in report.errors:
        print(f"::error::{error}", file=sys.stderr)
    if report.errors:
        print(
            f"FFmpeg pin gate FAILED with {len(report.errors)} error(s): the build "
            "downloads a binary that is not pinned, not verified, or not recorded.",
            file=sys.stderr,
        )
        return 1
    print("FFmpeg pin gate passed: immutable release, per-arch SHA-256, verified and labelled.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
