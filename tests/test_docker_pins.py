"""Regression tests for the FFmpeg pin gate (tools/check_docker_pins.py).

The gate is what keeps the image's FFmpeg download pinned to a retained
immutable release and verified against a committed SHA-256, so the gate
itself must not be weakenable by a quiet edit: these tests pin each of its
load-bearing rejections. They also pin that the repository's own Dockerfile
and Proxmox CT builder pass, so the gate cannot rot into "always green".

The fixture is a minimal but structurally faithful stand-in — a fetcher stage
that declares the ARGs, downloads, verifies, and a final stage that repeats
them for the labels. Each test mutates exactly one property, and the Proxmox
script is kept in sync unless drift is the thing under test, so a failure can
only come from the property being asserted.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent
_GATE = _REPO / "tools" / "check_docker_pins.py"
_spec = importlib.util.spec_from_file_location("check_docker_pins", _GATE)
gate = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gate)

RELEASE = "autobuild-2026-07-31-14-10"
AMD64_TARBALL = "ffmpeg-n7.1.5-12-g1fdbca85aa-linux64-gpl-7.1.tar.xz"
ARM64_TARBALL = "ffmpeg-n7.1.5-12-g1fdbca85aa-linuxarm64-gpl-7.1.tar.xz"
AMD64_SHA = "c1e6caf48923dd8e6bc5e54d51ba70c321175b8162ae9c414c392990e72f0e79"
ARM64_SHA = "a9a50c5782ef5e45306d58d1a9a819015b472d8da30ab6a77f15f571c861a71b"

# The exact state #105 reported: a mutable release, floating asset names, and
# no checksum pins at all.
REGRESSED_RELEASE = "latest"
REGRESSED_AMD64 = "ffmpeg-n7.1-latest-linux64-gpl-7.1.tar.xz"
REGRESSED_ARM64 = "ffmpeg-n7.1-latest-linuxarm64-gpl-7.1.tar.xz"


def _dockerfile(
    release: str = RELEASE,
    amd64_tarball: str = AMD64_TARBALL,
    arm64_tarball: str = ARM64_TARBALL,
    amd64_sha: str = AMD64_SHA,
    arm64_sha: str = ARM64_SHA,
    verify: bool = True,
    swallow: str = "",
    empty_guard: bool = True,
    final_release: str | None = None,
    labels: bool = True,
    comment: str = "",
    middle_stage: str = "",
    final_args: bool = True,
) -> str:
    """Render a Dockerfile. Every knob defaults to the *passing* shape."""
    if verify:
        # `swallow` is the text a maintainer would append to disable the check.
        verify_block = (
            f'    && echo "${{FFMPEG_SHA256}}  /tmp/ffmpeg.tar.xz" | sha256sum -c {swallow}\\\n'
            if swallow
            else '    && echo "${FFMPEG_SHA256}  /tmp/ffmpeg.tar.xz" | sha256sum -c - \\\n'
        )
    else:
        verify_block = ""
    guard_block = (
        '    && if [ -z "$FFMPEG_SHA256" ]; then exit 1; fi \\\n' if empty_guard else ""
    )
    comment_block = f"# {comment}\n" if comment else ""
    label_block = (
        'LABEL org.feedBack.ffmpeg.release="${FFMPEG_RELEASE}" \\\n'
        '      org.feedBack.ffmpeg.source.amd64="${FFMPEG_BUILD_AMD64}" \\\n'
        '      org.feedBack.ffmpeg.source.arm64="${FFMPEG_BUILD_ARM64}" \\\n'
        '      org.feedBack.ffmpeg.sha256.amd64="${FFMPEG_SHA256_AMD64}" \\\n'
        '      org.feedBack.ffmpeg.sha256.arm64="${FFMPEG_SHA256_ARM64}"\n'
        if labels
        else ""
    )

    def _args(tag: str) -> str:
        return (
            f"ARG FFMPEG_RELEASE={tag}\n"
            f"ARG FFMPEG_BUILD_AMD64={amd64_tarball}\n"
            f"ARG FFMPEG_BUILD_ARM64={arm64_tarball}\n"
            f"ARG FFMPEG_SHA256_AMD64={amd64_sha}\n"
            f"ARG FFMPEG_SHA256_ARM64={arm64_sha}\n"
        )

    return (
        "FROM alpine:3.20 AS ffmpeg-fetcher\n"
        "ARG TARGETARCH\n"
        f"{_args(release)}"
        f"{comment_block}"
        "RUN apk add --no-cache curl xz \\\n"
        '    && curl -fsSL "${FFMPEG_RELEASE}/x" -o /tmp/ffmpeg.tar.xz \\\n'
        f"{verify_block}{guard_block}"
        "    && tar -xJf /tmp/ffmpeg.tar.xz -C /out\n"
        "\n"
        f"{middle_stage}"
        "FROM python:3.12-slim\n"
        + (f"{_args(final_release or release)}" if final_args else "")
        + f"{label_block}"
        "COPY --from=ffmpeg-fetcher /out/ffmpeg /usr/local/bin/\n"
    )


def _proxmox(
    release: str = RELEASE,
    amd64_tarball: str = AMD64_TARBALL,
    arm64_tarball: str = ARM64_TARBALL,
    amd64_sha: str = AMD64_SHA,
    arm64_sha: str = ARM64_SHA,
) -> str:
    """The CT builder's pins — pass matching values to keep it in sync."""
    return (
        f'FFMPEG_RELEASE="{release}"\n'
        f'FFMPEG_BUILD_AMD64="{amd64_tarball}"\n'
        f'FFMPEG_BUILD_ARM64="{arm64_tarball}"\n'
        f"FFMPEG_SHA256_AMD64={amd64_sha}\n"
        f"FFMPEG_SHA256_ARM64={arm64_sha}\n"
    )


def _errors(tmp_path: Path, dockerfile: str, proxmox: str) -> list[str]:
    report = gate.Report()
    docker = tmp_path / "Dockerfile"
    docker.write_text(dockerfile, encoding="utf-8")
    gate.check_dockerfile(docker, report)
    script = tmp_path / "build-proxmox-ct.sh"
    script.write_text(proxmox, encoding="utf-8")
    gate.check_proxmox_script(script, docker, report)
    return report.errors


def _synced(tmp_path: Path, **kwargs) -> list[str]:
    """Failures for a mutated Dockerfile whose CT-builder pins still match.

    Keeping the script in sync is the point: a mirror-mismatch error would
    otherwise be able to mask a rejection that is really under test.
    """
    dockerfile = _dockerfile(**kwargs)
    proxmox = _proxmox(
        release=kwargs.get("release", RELEASE),
        amd64_tarball=kwargs.get("amd64_tarball", AMD64_TARBALL),
        arm64_tarball=kwargs.get("arm64_tarball", ARM64_TARBALL),
        amd64_sha=kwargs.get("amd64_sha", AMD64_SHA),
        arm64_sha=kwargs.get("arm64_sha", ARM64_SHA),
    )
    return _errors(tmp_path, dockerfile, proxmox)


# ------------------------------------------------------------- the happy path

def test_repo_dockerfile_and_ct_builder_pass():
    report = gate.Report()
    gate.check_dockerfile(_REPO / "Dockerfile", report)
    gate.check_proxmox_script(_REPO / "build-proxmox-ct.sh", _REPO / "Dockerfile", report)
    assert report.errors == []


def test_fixture_baseline_passes(tmp_path):
    assert _synced(tmp_path) == []


# ------------------------------------ the whole #105 state, as one regression

def test_the_reported_issue_state_is_rejected(tmp_path):
    # Every property broken at once, exactly as #105 reported it. If this ever
    # passes, the gate is decorative.
    dockerfile = _dockerfile(
        release=REGRESSED_RELEASE,
        amd64_tarball=REGRESSED_AMD64,
        arm64_tarball=REGRESSED_ARM64,
        amd64_sha="",
        arm64_sha="",
        verify=False,
        empty_guard=False,
        final_release=REGRESSED_RELEASE,
        labels=False,
    )
    proxmox = _proxmox(
        release=REGRESSED_RELEASE,
        amd64_tarball=REGRESSED_AMD64,
        arm64_tarball=REGRESSED_ARM64,
        amd64_sha="",
    )
    errors = _errors(tmp_path, dockerfile, proxmox)
    assert len(errors) == 14, errors
    # Every one of those must be about a property #105 broke. If the count
    # were reachable with unrelated errors, the smoke alarm would be noise.
    for expected in (
        "FFMPEG_RELEASE",
        "FFMPEG_BUILD_AMD64",
        "FFMPEG_BUILD_ARM64",
        "FFMPEG_SHA256_AMD64",
        "FFMPEG_SHA256_ARM64",
        "never verified",
        "empty-checksum guard",
        "not provenance",
    ):
        assert any(expected in e for e in errors), (expected, errors)


# ------------------------------------------------- (1) immutable-ref, (2) hashed

def test_floating_latest_release_is_rejected(tmp_path):
    # `latest` is a mutable ref whose assets are replaced in place, so two
    # builds of one commit can embed different binaries.
    errors = _synced(tmp_path, release="latest")
    assert any("FFMPEG_RELEASE" in e and "autobuild" in e for e in errors)


def test_latest_asset_name_is_rejected(tmp_path):
    # The gate must reject the floating asset name on its own, with the CT
    # builder's pins still matching — otherwise the mirror-mismatch error can
    # mask the fact that the asset shape was never actually checked.
    errors = _synced(tmp_path, amd64_tarball=REGRESSED_AMD64)
    assert [e for e in errors if "-g<commit>" in e], errors


def test_master_track_asset_name_is_rejected(tmp_path):
    # BtbN's `nN-…` master track carries no series and floats per build.
    errors = _synced(tmp_path, amd64_tarball="ffmpeg-N-125875-g5d4d3bdc61-linux64-gpl.tar.xz")
    assert [e for e in errors if "-g<commit>" in e], errors


def test_empty_checksum_is_rejected(tmp_path):
    errors = _synced(tmp_path, arm64_sha="")
    assert [e for e in errors if "not a 64-char" in e], errors


def test_malformed_checksum_is_rejected(tmp_path):
    errors = _synced(tmp_path, amd64_sha="deadbeef")
    assert [e for e in errors if "not a 64-char" in e], errors


def test_missing_arg_declaration_is_rejected(tmp_path):
    dockerfile = _dockerfile().replace("ARG FFMPEG_SHA256_ARM64=" + ARM64_SHA + "\n", "", 1)
    errors = _errors(tmp_path, dockerfile, _proxmox())
    assert any("ARG FFMPEG_SHA256_ARM64" in e for e in errors)


# ------------------------------------------------------------------ (3) verified

def test_unverified_download_is_rejected(tmp_path):
    # A committed hash nobody checks is decoration, not a pin.
    errors = _synced(tmp_path, verify=False)
    assert [e for e in errors if "never verified" in e], errors


def test_a_comment_cannot_satisfy_the_verification_check(tmp_path):
    # Exactly what a "tidy up the Dockerfile" PR would leave behind.
    errors = _synced(tmp_path, verify=False, comment="the tarball is checked with sha256sum -c")
    assert [e for e in errors if "never verified" in e], errors


def test_a_comment_cannot_satisfy_the_empty_checksum_guard(tmp_path):
    errors = _synced(
        tmp_path,
        empty_guard=False,
        comment='a -z "$FFMPEG_SHA256" test aborts the build when the pin is missing',
    )
    assert [e for e in errors if "empty-checksum guard" in e], errors


def test_a_missing_empty_checksum_guard_is_rejected(tmp_path):
    # Without the guard, dropping the pin silently downgrades to no pin.
    errors = _synced(tmp_path, empty_guard=False)
    assert [e for e in errors if "empty-checksum guard" in e], errors


def test_a_trailing_comment_on_a_proxmox_pin_is_tolerated(tmp_path):
    # Fail-closed, but not noise: a documented pin is still a pin.
    proxmox = _proxmox().replace(
        f'FFMPEG_RELEASE="{RELEASE}"',
        f'FFMPEG_RELEASE="{RELEASE}"  # month-end tag, retained two years',
    )
    assert _errors(tmp_path, _dockerfile(), proxmox) == []


def test_a_later_reassignment_in_the_proxmox_script_is_rejected(tmp_path):
    # The shell's last assignment wins, so the gate's must too.
    errors = _errors(tmp_path, _dockerfile(), _proxmox() + 'FFMPEG_RELEASE="latest"\n')
    assert [e for e in errors if "FFMPEG_RELEASE" in e], errors


def test_a_swallowed_verification_result_is_rejected(tmp_path):
    errors = _synced(tmp_path, swallow="|| true \\")
    assert [e for e in errors if "discarded" in e], errors


def test_every_failure_discarding_construct_is_rejected(tmp_path):
    # Docker folds `\` continuations into one command before running it, so a
    # `|| true` on the *next* physical line swallows the check just as surely.
    for discard in ("|| true", "|| :", "|| exit 0", "set +e"):
        errors = _synced(tmp_path, swallow=discard)
        assert [e for e in errors if "discarded" in e], (discard, errors)


def test_an_inline_comment_cannot_hide_a_verification(tmp_path):
    # `echo ok # && … sha256sum -c` prints `ok` and checks nothing. The gate
    # must judge the command the shell runs, not the line's text.
    dockerfile = _dockerfile().replace(
        '    && echo "${FFMPEG_SHA256}  /tmp/ffmpeg.tar.xz" | sha256sum -c - \\',
        '    && echo ok # && echo "${FFMPEG_SHA256}  /tmp/ffmpeg.tar.xz" | sha256sum -c - \\',
    )
    errors = _errors(tmp_path, dockerfile, _proxmox())
    assert [e for e in errors if "never verified" in e], errors


def test_an_inline_comment_cannot_hide_the_empty_checksum_guard(tmp_path):
    dockerfile = _dockerfile().replace(
        '    && if [ -z "$FFMPEG_SHA256" ]; then exit 1; fi \\',
        '    && echo ok # && if [ -z "$FFMPEG_SHA256" ]; then exit 1; fi \\',
    )
    errors = _errors(tmp_path, dockerfile, _proxmox())
    assert [e for e in errors if "empty-checksum guard" in e], errors


def test_a_hash_check_on_an_unrelated_file_is_rejected(tmp_path):
    # The check has to cover the artifact that was downloaded.
    dockerfile = _dockerfile().replace("/tmp/ffmpeg.tar.xz\" | sha256sum", "/tmp/other\" | sha256sum")
    errors = _errors(tmp_path, dockerfile, _proxmox())
    assert [e for e in errors if "unverified" in e], errors


def test_a_decoy_stage_cannot_absorb_the_fetcher_checks(tmp_path):
    # `AS ffmpeg-fetcher-cache` contains the marker as a substring; if that
    # stage were matched, a decoy could vouch for a real fetcher that is
    # pinned to `latest` and verifies nothing.
    decoy = (
        "FROM alpine:3.20 AS ffmpeg-fetcher-cache\n"
        f"ARG FFMPEG_RELEASE={RELEASE}\n"
        f"ARG FFMPEG_BUILD_AMD64={AMD64_TARBALL}\n"
        f"ARG FFMPEG_BUILD_ARM64={ARM64_TARBALL}\n"
        f"ARG FFMPEG_SHA256_AMD64={AMD64_SHA}\n"
        f"ARG FFMPEG_SHA256_ARM64={ARM64_SHA}\n"
        "RUN echo x | sha256sum -c - && if [ -z \"$FFMPEG_SHA256\" ]; then exit 1; fi\n"
        "\n"
    )
    broken = _dockerfile(release="latest", verify=False, empty_guard=False)
    broken = broken.replace("FROM alpine:3.20 AS ffmpeg-fetcher\n", decoy + "FROM alpine:3.20 AS ffmpeg-fetcher\n", 1)
    errors = _errors(tmp_path, broken, _proxmox())
    assert [e for e in errors if "FFMPEG_RELEASE" in e], errors
    assert [e for e in errors if "never verified" in e], errors


def test_a_lowercase_or_indented_from_is_still_recognised(tmp_path):
    # Dockerfile keywords are case-insensitive; a reformat must not be
    # misreported as a missing fetcher stage.
    dockerfile = _dockerfile().replace(
        "FROM alpine:3.20 AS ffmpeg-fetcher", "  from alpine:3.20 as ffmpeg-fetcher"
    )
    errors = _errors(tmp_path, dockerfile, _proxmox())
    assert errors == []


# ------------------------------------------------------------------- (4) labelled

def test_final_stage_must_repeat_the_fetch_pins(tmp_path):
    errors = _synced(tmp_path, final_release="latest")
    assert [e for e in errors if "disagrees with the fetcher's" in e], errors


def test_an_intermediate_stage_cannot_satisfy_the_final_stage(tmp_path):
    # The check is about the image that ships. An earlier stage declaring the
    # ARGs and the labels must not stand in for the final one.
    middle = (
        "FROM node:22-slim AS tailwind-builder\n"
        f"ARG FFMPEG_RELEASE={RELEASE}\n"
        f"ARG FFMPEG_BUILD_AMD64={AMD64_TARBALL}\n"
        f"ARG FFMPEG_BUILD_ARM64={ARM64_TARBALL}\n"
        f"ARG FFMPEG_SHA256_AMD64={AMD64_SHA}\n"
        f"ARG FFMPEG_SHA256_ARM64={ARM64_SHA}\n"
        'LABEL org.feedBack.ffmpeg.release="${FFMPEG_RELEASE}" \\\n'
        '      org.feedBack.ffmpeg.source.amd64="${FFMPEG_BUILD_AMD64}" \\\n'
        '      org.feedBack.ffmpeg.source.arm64="${FFMPEG_BUILD_ARM64}" \\\n'
        '      org.feedBack.ffmpeg.sha256.amd64="${FFMPEG_SHA256_AMD64}" \\\n'
        '      org.feedBack.ffmpeg.sha256.arm64="${FFMPEG_SHA256_ARM64}"\n'
        "\n"
    )
    errors = _synced(
        tmp_path, final_args=False, labels=False, middle_stage=middle
    )
    assert len([e for e in errors if "is not re-declared" in e]) == 5, errors
    assert len([e for e in errors if "missing `LABEL" in e]) == 5, errors


def test_a_label_in_an_intermediate_stage_does_not_satisfy_the_final_one(tmp_path):
    # Same concern, narrower: the LABEL scan must be scoped to the final
    # stage, not anywhere in the file.
    middle = (
        "FROM node:22-slim AS tailwind-builder\n"
        'LABEL org.feedBack.ffmpeg.release="${FFMPEG_RELEASE}" \\\n'
        '      org.feedBack.ffmpeg.source.amd64="${FFMPEG_BUILD_AMD64}" \\\n'
        '      org.feedBack.ffmpeg.source.arm64="${FFMPEG_BUILD_ARM64}" \\\n'
        '      org.feedBack.ffmpeg.sha256.amd64="${FFMPEG_SHA256_AMD64}" \\\n'
        '      org.feedBack.ffmpeg.sha256.arm64="${FFMPEG_SHA256_ARM64}"\n'
        "\n"
    )
    errors = _synced(tmp_path, labels=False, middle_stage=middle)
    assert len([e for e in errors if "missing `LABEL" in e]) == 5, errors


def test_a_label_must_reference_the_pin_not_hardcode_a_value(tmp_path):
    # A label that names a hash but hardcodes it will drift the moment the
    # ARG is bumped, leaving provenance that describes nothing.
    dockerfile = _dockerfile().replace(
        'org.feedBack.ffmpeg.sha256.amd64="${FFMPEG_SHA256_AMD64}"',
        f"org.feedBack.ffmpeg.sha256.amd64={AMD64_SHA}",
    )
    errors = _errors(tmp_path, dockerfile, _proxmox())
    assert [e for e in errors if "does not interpolate" in e], errors


def test_a_bare_arg_name_is_not_interpolation(tmp_path):
    # Records the literal string `FFMPEG_SHA256_AMD64` as the hash.
    dockerfile = _dockerfile().replace(
        'org.feedBack.ffmpeg.sha256.amd64="${FFMPEG_SHA256_AMD64}"',
        "org.feedBack.ffmpeg.sha256.amd64=FFMPEG_SHA256_AMD64",
    )
    errors = _errors(tmp_path, dockerfile, _proxmox())
    assert [e for e in errors if "does not interpolate" in e], errors


def test_a_shell_default_fallback_to_the_floating_ref_is_rejected(tmp_path):
    # `${FFMPEG_RELEASE:-latest}` documents a silent downgrade to the ref
    # this whole change exists to remove.
    dockerfile = _dockerfile().replace(
        'org.feedBack.ffmpeg.release="${FFMPEG_RELEASE}"',
        'org.feedBack.ffmpeg.release="${FFMPEG_RELEASE:-latest}"',
    )
    errors = _errors(tmp_path, dockerfile, _proxmox())
    assert [e for e in errors if "does not interpolate" in e], errors


def test_key_value_lines_that_are_not_labels_are_rejected(tmp_path):
    # `org.feedBack.ffmpeg.*=…` written into a RUN records nothing; the image
    # would ship with no provenance labels at all.
    dockerfile = _dockerfile(labels=False).replace(
        "COPY --from=ffmpeg-fetcher",
        'RUN printf \'%s\\n\' \\\n'
        '      org.feedBack.ffmpeg.release="${FFMPEG_RELEASE}" \\\n'
        '      org.feedBack.ffmpeg.source.amd64="${FFMPEG_BUILD_AMD64}" \\\n'
        '      org.feedBack.ffmpeg.source.arm64="${FFMPEG_BUILD_ARM64}" \\\n'
        '      org.feedBack.ffmpeg.sha256.amd64="${FFMPEG_SHA256_AMD64}" \\\n'
        '      org.feedBack.ffmpeg.sha256.arm64="${FFMPEG_SHA256_ARM64}"\n'
        "COPY --from=ffmpeg-fetcher",
    )
    errors = _errors(tmp_path, dockerfile, _proxmox())
    assert len([e for e in errors if "missing `LABEL" in e]) == 5, errors


def test_missing_hash_label_is_rejected(tmp_path):
    dockerfile = _dockerfile().replace(
        '      org.feedBack.ffmpeg.sha256.arm64="${FFMPEG_SHA256_ARM64}"\n', ""
    )
    errors = _errors(tmp_path, dockerfile, _proxmox())
    assert [e for e in errors if "missing `LABEL" in e], errors


def test_all_labels_removed_is_rejected(tmp_path):
    errors = _synced(tmp_path, labels=False)
    assert len([e for e in errors if "missing `LABEL" in e]) == 5, errors


# -------------------------------------------------------------------- (5) mirrored

def test_proxmox_release_drift_is_rejected(tmp_path):
    errors = _errors(tmp_path, _dockerfile(), _proxmox(release="autobuild-2026-06-30-13-34"))
    assert [e for e in errors if "disagrees with the Dockerfile's" in e], errors


def test_proxmox_hash_drift_is_rejected(tmp_path):
    errors = _errors(tmp_path, _dockerfile(), _proxmox(amd64_sha="0" * 64))
    assert [e for e in errors if "FFMPEG_SHA256_AMD64" in e], errors


def test_missing_fetcher_stage_is_reported(tmp_path):
    dockerfile = _dockerfile().replace("AS ffmpeg-fetcher", "AS something-else")
    errors = _errors(tmp_path, dockerfile, _proxmox())
    assert any("no build stage" in e for e in errors)


def test_report_collects_every_failure_not_just_the_first(tmp_path):
    # Assert the properties, not a count: the point is that the run does not
    # stop at the first problem, so later independent failures still surface.
    errors = _synced(tmp_path, release="latest", amd64_sha="")
    assert [e for e in errors if "FFMPEG_RELEASE" in e], errors
    assert [e for e in errors if "not a 64-char" in e], errors
    assert [e for e in errors if e.startswith("build-proxmox-ct.sh")], errors


# ----------------------------------------------------------------------- entry

def test_main_reports_nonzero_on_a_bad_dockerfile(tmp_path, monkeypatch):
    (tmp_path / "Dockerfile").write_text(
        _dockerfile(release="latest"), encoding="utf-8"
    )
    (tmp_path / "build-proxmox-ct.sh").write_text(_proxmox(), encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    assert gate.main([]) == 1


def test_main_reports_zero_on_the_repo_tree(monkeypatch):
    monkeypatch.chdir(_REPO)
    assert gate.main([]) == 0
