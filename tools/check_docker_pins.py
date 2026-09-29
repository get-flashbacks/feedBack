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

  1. immutable-ref   — the release is a concrete dated `autobuild-*` tag
                       naming a real calendar date, not `latest` /
                       `master-latest`, and each asset name carries the
                       concrete FFmpeg commit it was built from, not a
                       `-latest-` placeholder. Naming one asset for both
                       architectures is rejected: one of them would download
                       the wrong binary.
  2. hashed          — every architecture has a 64-hex SHA-256 pin.
  3. verified        — the fetcher stage runs `sha256sum -c` against the file
                       it actually downloaded, reading the selected pin rather
                       than a hardcoded digest, and fed by a URL built from the
                       pinned release. The check must be code the shell will
                       execute (not a comment, not a `RUN` heredoc body, on any
                       continuation line), and its result must decide the exit
                       status — no `|| …`, no `;` or pipe or `&` after it, no
                       `!` inversion, no `set +e`. It also hard-fails when the
                       pin is empty, rather than warning or reassigning one. A
                       build that cannot verify must not produce an image. The
                       checks reason about the *unfolded* command, because
                       Docker joins `\` continuations before running.
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
import datetime
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
# Where each class of failure is reported, so one run groups them by surface.
FETCHER_WHERE = "Dockerfile/ffmpeg-fetcher"
FINAL_WHERE = "Dockerfile/final"
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

_HEREDOC_RE = re.compile(r"<<(?P<dash>-)?(?P<quote>['\"]?)(?P<word>[A-Za-z_][A-Za-z0-9_]*)(?P=quote)")

# The per-architecture variable the fetcher selects at build time. A check that
# hardcodes a digest instead of reading this is verifying something else.
SELECTED_SHA_VAR = r"\$\{?FFMPEG_SHA256(?![_A-Z0-9])\}?"
RELEASE_VAR = r"\$\{?FFMPEG_RELEASE(?![_A-Z0-9])\}?"

# A guard must *fail the build*, not mention the empty pin: `then echo "warn"`
# and `then FFMPEG_SHA256=deadbeef` both pass a bare `-z` mention.
_FAILURE_ACTIONS = re.compile(
    r"\bexit\s+(?:[1-9]|\$\{?[A-Za-z_])"  # exit 1 / exit "$STATUS"
    r"|\breturn\s+[1-9]"
    r"|\bfalse\b"
    r"|\|\|\s*(?:exit\s+[1-9]|false)"
)

# A `fi` that closes a block, not the `fi` inside a word like "unverified".
_CLOSING_FI = re.compile(r"(?:^|[\s;&|(])fi(?:[\s;&|)]|$)")


def _is_real_date(tag: str) -> bool:
    """True if an `autobuild-<date>-<hh>-<mm>` tag names a real calendar date."""
    m = re.match(r"^autobuild-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})$", tag)
    if not m:
        return False
    year, month, day, hour, minute = (int(g) for g in m.groups())
    try:
        datetime.date(year, month, day)
    except ValueError:
        return False
    return hour <= 23 and minute <= 59


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


def _unfold(lines: list[str]) -> list[str]:
    """Join backslash continuations, as Docker does before running a `RUN`."""
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
    return joined


def _logical(lines: list[str]) -> list[str]:
    """The commands a stage actually runs: unfolded, heredocs dropped, no comments.

    A heredoc body is data, not commands — leaving it in would let a
    `<<'EOF'` block supply a `sha256sum -c` or a `LABEL` line that the shell
    never executes, and the image would ship unverified and unlabelled.
    """
    out: list[str] = []
    terminator: str | None = None
    strip_tabs = False
    for raw in _unfold(lines):
        if terminator is not None:
            candidate = raw.lstrip("\t") if strip_tabs else raw
            if candidate.strip() == terminator:
                terminator = None
            continue
        for m in _HEREDOC_RE.finditer(raw):
            terminator = m.group("word")
            strip_tabs = m.group("dash") == "-"
            break
        out.append(_strip_shell_comment(raw))
    return out


def _strip_shell_comment(line: str) -> str:
    """Remove a trailing `#` comment using the shell's own rule.

    A `#` only opens a comment at the start of a word, so `${VAR#prefix}`,
    `a#b`, and a backslash-escaped `#` are all literal text. Getting this
    wrong in the strict direction would truncate a real command and reject a
    good Dockerfile.
    """
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
        elif ch == "#" and (not out or out[-1].isspace()):
            break  # a `#` at a word boundary starts a comment
        else:
            out.append(ch)
        i += 1
    return "".join(out).strip()


def _unquoted(text: str) -> str:
    """Blank out quoted spans so operators inside strings are not operators."""
    out: list[str] = []
    quote: str | None = None
    i = 0
    while i < len(text):
        ch = text[i]
        if quote == '"' and ch == "\\" and i + 1 < len(text):
            out.append("  ")
            i += 2
            continue
        if quote:
            out.append(" ")
            if ch == quote:
                quote = None
        elif ch in "\"'":
            quote = ch
            out.append(" ")
        else:
            out.append(ch)
        i += 1
    return "".join(out)


def _segments(line: str) -> list[tuple[str, str]]:
    """Split one command into `&&`/`||`/`;` parts, each with its trailing separator.

    A single `|` is deliberately *not* a separator: `echo "$H  f" | sha256sum -c -`
    is one command whose data and check belong together. It is handled instead
    by `check_dockerfile`, which rejects any pipe appearing after the marker.
    """
    parts: list[tuple[str, str]] = []
    current: list[str] = []
    quote: str | None = None
    i = 0
    while i < len(line):
        ch = line[i]
        if quote == '"' and ch == "\\" and i + 1 < len(line):
            current.append(line[i: i + 2])
            i += 2
            continue
        if quote:
            current.append(ch)
            if ch == quote:
                quote = None
        elif ch in "\"'":
            quote = ch
            current.append(ch)
        elif line[i: i + 2] in ("&&", "||"):
            parts.append(("".join(current), line[i: i + 2]))
            current = []
            i += 2
            continue
        elif ch == ";":
            parts.append(("".join(current), ";"))
            current = []
        else:
            current.append(ch)
        i += 1
    parts.append(("".join(current), ""))
    return parts


def _curl_outputs(line: str) -> set[str]:
    """Paths a `curl` in this command writes, via `-o`/`--output` in any spelling.

    Walks tokens outside quotes so `-o` inside a URL query string is not read
    as a flag, and accepts `--output=`, `--output `, `-o `, and bundled short
    flags like `-sfo`. Shell redirection counts too: `curl … > /tmp/f.tar.xz`
    writes the download just as verifiably, and refusing to model it would
    only push a maintainer back toward a form the gate cannot follow.
    """
    targets: set[str] = set()
    tokens = _tokens_outside_quotes(line)
    for i, tok in enumerate(tokens):
        if tok.startswith("--output="):
            targets.add(tok.split("=", 1)[1])
        elif tok == "--output" and i + 1 < len(tokens):
            targets.add(tokens[i + 1])
        elif re.fullmatch(r"-[A-Za-z]*o[A-Za-z]*", tok) and i + 1 < len(tokens):
            targets.add(tokens[i + 1])
        elif tok in (">", ">>") and i + 1 < len(tokens):
            targets.add(tokens[i + 1])
        elif tok.startswith(">") and len(tok) > 1:
            targets.add(tok[1:].lstrip(">"))
    return targets


def _tokens_outside_quotes(line: str) -> list[str]:
    """Whitespace-split tokens, keeping quoted runs intact as one token."""
    tokens: list[str] = []
    current: list[str] = []
    quote: str | None = None
    for ch in line:
        if quote:
            current.append(ch)
            if ch == quote:
                quote = None
                tokens.append("".join(current))
                current = []
        elif ch in "\"'":
            quote = ch
            current.append(ch)
        elif ch.isspace():
            if current:
                tokens.append("".join(current))
                current = []
        else:
            current.append(ch)
    if current:
        tokens.append("".join(current))
    return tokens


def _downloads(fetcher_code: list[str], report: Report) -> set[str] | None:
    """The paths the fetcher's `curl` invocations write, or None if unknowable.

    Every download must be built from the pinned release, so a URL that never
    references `$FFMPEG_RELEASE` is reported here — the caller cannot see it,
    and such a fetch resolves whatever the mutable ref happens to name.
    """
    # `curl` must be the command being run, not merely a package name in
    # `apk add --no-cache curl xz`.
    where = FETCHER_WHERE
    curl_cmd = re.compile(r"(?:^|&&|\|\||;|\|)\s*curl(?:\s|$)")
    curl_segments = [
        text
        for line in fetcher_code
        for text, _ in _segments(line)
        if curl_cmd.search(_unquoted(text))
    ]
    if not curl_segments:
        report.fail(
            where,
            "no curl download found in the fetcher, so there is nothing to verify",
        )
        return None
    for text in curl_segments:
        if not re.search(RELEASE_VAR, text):
            report.fail(
                where,
                "the download URL does not use `$FFMPEG_RELEASE`; the pinned release "
                "must be what is actually fetched",
            )
    downloaded: set[str] = set()
    for text in curl_segments:
        downloaded |= _curl_outputs(text)
    # Fail closed: if no download target can be identified, coverage is unknown.
    if not downloaded:
        report.fail(
            where,
            "cannot identify what curl writes, so the download cannot be shown to "
            "be verified",
        )
        return None
    return downloaded


def _check_exit_status(text: str, sep: str, report: Report) -> None:
    """The check's result has to be what the shell derives its exit status from.

    Anything that folds the verdict away — a trailing command, a pipe, a
    trailing `&`, a `||` fallback, or a `!` inversion — lets a mismatch build
    an image anyway, so each shape gets its own diagnostic.
    """
    where = FETCHER_WHERE
    marker = text.find("sha256sum -c")
    head, tail = text[:marker], text[marker:]
    # Everything after the marker decides the exit status.
    if "|" in _unquoted(tail) or re.search(r"(?<![>&])&\s*$", _unquoted(tail)):
        report.fail(
            where,
            "the `sha256sum -c` status is overwritten (a pipe or `&` after "
            "it); a failed check must abort the build",
        )
    if sep == "||":
        report.fail(
            where,
            "the `sha256sum -c` result is discarded (`|| …`); a failed check "
            "must abort the build",
        )
    if sep == ";":
        # `sha256sum -c - ; echo done` exits 0 regardless of the check.
        report.fail(
            where,
            "a command after the `sha256sum -c` overwrites its exit status "
            "(`;`); a failed check must abort the build",
        )
    # A leading `!` inverts the verdict, so a mismatch exits 0.
    if re.search(r"(?:^|\s)!(?=\s|$)", _unquoted(head)):
        report.fail(
            where,
            "the `sha256sum -c` result is inverted (`!`); a failed check must "
            "abort the build",
        )


def _check_covers_download(text: str, downloaded: set[str], report: Report) -> None:
    """The check must read the selected pin *and* cover the file curl wrote."""
    where = FETCHER_WHERE
    if not re.search(SELECTED_SHA_VAR, text):
        report.fail(
            where,
            "the checksum check does not read the selected `$FFMPEG_SHA256`; "
            "it verifies something other than the pin",
        )
    if not {p for p in downloaded if p in text}:
        report.fail(
            where,
            f"`sha256sum -c` does not check the downloaded tarball "
            f"({', '.join(sorted(downloaded))}); it is fetched unverified",
        )


def _check_verified(fetcher_code: list[str], report: Report) -> None:
    """The check must run, read the selected pin, cover the download, and matter."""
    where = FETCHER_WHERE
    verifying = [line for line in fetcher_code if "sha256sum -c" in line]
    if not verifying:
        report.fail(
            where,
            "the download is never verified — no `sha256sum -c` against the pinned hash",
        )
        return

    downloaded = _downloads(fetcher_code, report)
    if downloaded is None:
        return

    for line in verifying:
        # Variable references are matched in the *raw* segment text (the real
        # Dockerfile quotes them: `-z "$FFMPEG_SHA256"`), while operators are
        # matched in the unquoted form. Both are scoped to a single command so
        # a mention elsewhere in the folded RUN cannot vouch for this one.
        for text, sep in _segments(line):
            if text.find("sha256sum -c") < 0:
                continue
            _check_exit_status(text, sep, report)
            _check_covers_download(text, downloaded, report)
    if any(re.search(r"\bset\s+\+e\b", line) for line in fetcher_code):
        report.fail(
            where,
            "the fetcher disables errexit (`set +e`), so a failed check would not "
            "abort the build",
        )


def _check_empty_guard(fetcher_code: list[str], report: Report) -> None:
    """A missing pin must fail the build, not merely be noticed."""
    where = FETCHER_WHERE
    guard = re.compile(r"-z\s+\"?" + SELECTED_SHA_VAR)
    for line in fetcher_code:
        m = guard.search(line)
        if not m:
            continue
        # The `if` body runs from the test to the block's own closing `fi`.
        # Match `fi` as a word: a bare `find` also matches inside "unverified",
        # and the diagnostics in this very block contain such words.
        rest = line[m.start():]
        end = _CLOSING_FI.search(rest)
        if _FAILURE_ACTIONS.search(rest[: end.start()] if end else rest):
            return
    report.fail(
        where,
        "no empty-checksum guard that fails the build. A build must abort when the "
        "expected SHA-256 is missing rather than skipping verification.",
    )


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


def _locate_stages(
    stages: list[tuple[str, list[str]]], report: Report
) -> tuple[list[str], list[str]] | None:
    """Resolve the fetcher stage and the final image stage that carries labels.

    Returns None once the Dockerfile is too broken to check further; each
    missing stage is still reported, so one run names every problem.
    """
    fetcher_lines = _stage(stages)
    if fetcher_lines is None:
        report.fail("Dockerfile", f"no build stage named `{FETCHER_MARKER}`")
    # The fetcher is a throwaway stage, so the image that ships must be a
    # *later* one; if the fetcher is last there is nothing to carry labels.
    if not stages or _is_fetcher(stages[-1][0]):
        report.fail("Dockerfile", "no final image stage after the ffmpeg fetcher")
    final_lines = stages[-1][1] if stages else None
    if fetcher_lines is None or final_lines is None:
        return None
    return fetcher_lines, final_lines


def _check_immutable_ref(fetcher: dict[str, str], report: Report) -> None:
    """(1) immutable-ref + (2) hashed, on the values that drive the download."""
    where = FETCHER_WHERE
    release = fetcher["FFMPEG_RELEASE"]
    if not RELEASE_RE.match(release) or not _is_real_date(release):
        report.fail(
            where,
            f"FFMPEG_RELEASE={release!r} is not a dated autobuild-* tag. "
            "`latest` is a mutable ref whose assets are replaced in place; pin a "
            "build BtbN retains, which for a long-lived image means one of the "
            "month-end tags it keeps for two years.",
        )
    for arch in ARCHES:
        asset = fetcher[f"FFMPEG_BUILD_{arch}"]
        if not ASSET_RE.match(asset):
            report.fail(
                where,
                f"FFMPEG_BUILD_{arch}={asset!r} is not a concrete "
                "`-g<commit>` tarball name; a `-latest-` segment means the "
                "asset floats.",
            )
        digest = fetcher[f"FFMPEG_SHA256_{arch}"]
        if not SHA256_RE.match(digest):
            report.fail(
                where,
                f"FFMPEG_SHA256_{arch}={digest!r} is not a 64-char lowercase hex "
                "SHA-256. Every download needs a non-empty expected checksum.",
            )
    if fetcher["FFMPEG_BUILD_AMD64"] == fetcher["FFMPEG_BUILD_ARM64"]:
        report.fail(
            where,
            "both architectures name the same asset, so one of them downloads the "
            "wrong binary",
        )


def _check_final_args(fetcher: dict[str, str], final: dict[str, str], report: Report) -> None:
    """(4a) the final stage must still hold the values the fetcher verified."""
    for name in ARG_NAMES:
        if name not in final:
            report.fail(
                FINAL_WHERE,
                f"`ARG {name}` is not re-declared, so the labels would lose it "
                "(ARG values do not cross stage boundaries)",
            )
        elif final[name] != fetcher[name]:
            report.fail(
                FINAL_WHERE,
                f"{name}={final[name]!r} disagrees with the fetcher's "
                f"{fetcher[name]!r}; the label would not describe the verified binary",
            )


def _check_labels(final_lines: list[str], report: Report) -> None:
    """(4b) the provenance must be real LABEL instructions interpolating the pins.

    A `key=value` line inside a `RUN` records nothing, so accepting one would
    leave the shipped image with no labels at all. Continuations are unfolded
    first, so a multi-key LABEL is one logical line, and comments are stripped
    so prose cannot stand in for an instruction.
    """
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
                FINAL_WHERE,
                f"`{full}` does not interpolate `${{{arg}}}`. A provenance label "
                "must record the pinned value at build time, not a literal that "
                "can drift from what was verified.",
            )
        else:
            report.fail(
                FINAL_WHERE,
                f"missing `LABEL {full}=...${{{arg}}}`. Provenance that cannot "
                "identify the shipped bytes is not provenance.",
            )


def check_dockerfile(path: Path, report: Report) -> None:
    """Run every Dockerfile check, reporting all failures in one pass."""
    located = _locate_stages(_split_stages(path.read_text(encoding="utf-8")), report)
    if located is None:
        return
    fetcher_lines, final_lines = located
    fetcher = _arg_defaults(fetcher_lines)
    final = _arg_defaults(final_lines)

    absent = [name for name in ARG_NAMES if name not in fetcher]
    for name in absent:
        report.fail(FETCHER_WHERE, f"`ARG {name}` is not declared")
    if absent:
        return

    _check_immutable_ref(fetcher, report)
    # (3) verified: the pin has to actually gate the build, in real code.
    # Reason over the *unfolded, comment-stripped* command list, because that
    # is what the shell runs: Docker joins `\` continuations into one command,
    # and a `#` mid-line comments out the rest of the physical line.
    fetcher_code = _logical(fetcher_lines)
    _check_verified(fetcher_code, report)
    _check_empty_guard(fetcher_code, report)
    # (4) labelled: the final stage must advertise exactly what was verified.
    _check_final_args(fetcher, final, report)
    _check_labels(final_lines, report)


def check_proxmox_script(path: Path, dockerfile: Path, report: Report) -> None:
    """(5) mirrored — the CT builder ships the same binary."""
    text = path.read_text(encoding="utf-8")
    # `(^|\s)` so an indented or `export`ed assignment is still seen — the
    # shell honours both, and last assignment wins. Comment lines are dropped
    # first: a commented-out assignment changes nothing at runtime.
    live = "\n".join(
        line for line in text.splitlines() if not line.lstrip().startswith("#")
    )
    shell = {
        name: value
        for name, value in re.findall(
            r"(?:^|\s)(?:export\s+|readonly\s+)?(FFMPEG_[A-Z0-9_]+)=\"?([^\"\s]+)\"?\s*(?:#.*)?$",
            live,
            re.MULTILINE,
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
