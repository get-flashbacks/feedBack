"""Regression tests for the FFmpeg pin gate (tools/check_docker_pins.py).

The gate is what keeps the image's FFmpeg download pinned to a retained
immutable release and verified against a committed SHA-256, so the gate
itself must not be weakenable by a quiet edit: these tests pin each of its
load-bearing rejections. They also pin that the repository's own Dockerfile
and Proxmox CT builder pass, so the gate cannot rot into "always green".

The fixture is a minimal but structurally faithful stand-in — a fetcher stage
that declares the ARGs, downloads, verifies, and a final stage that repeats
them for the labels. Each test mutates exactly one property.
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


def _dockerfile(
    release: str = RELEASE,
    amd64_tarball: str = AMD64_TARBALL,
    arm64_tarball: str = ARM64_TARBALL,
    amd64_sha: str = AMD64_SHA,
    arm64_sha: str = ARM64_SHA,
    verify: bool = True,
    empty_guard: bool = True,
    final_release: str | None = None,
    labels: bool = True,
) -> str:
    verify_block = '    && echo "${FFMPEG_SHA256}  /tmp/ffmpeg.tar.xz" | sha256sum -c - \\\n' if verify else ""
    guard_block = (
        '    && if [ -z "$FFMPEG_SHA256" ]; then exit 1; fi \\\n' if empty_guard else ""
    )
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
        "RUN apk add --no-cache curl xz \\\n"
        '    && curl -fsSL "${FFMPEG_RELEASE}/x" -o /tmp/ffmpeg.tar.xz \\\n'
        f"{verify_block}{guard_block}"
        "    && tar -xJf /tmp/ffmpeg.tar.xz -C /out\n"
        "\n"
        "FROM python:3.12-slim\n"
        f"{_args(final_release or release)}"
        f"{label_block}"
        "COPY --from=ffmpeg-fetcher /out/ffmpeg /usr/local/bin/\n"
    )


def _proxmox(release: str = RELEASE, amd64_sha: str = AMD64_SHA) -> str:
    return (
        f'FFMPEG_RELEASE="{release}"\n'
        f'FFMPEG_BUILD_AMD64="{AMD64_TARBALL}"\n'
        f'FFMPEG_BUILD_ARM64="{ARM64_TARBALL}"\n'
        f"FFMPEG_SHA256_AMD64={amd64_sha}\n"
        f"FFMPEG_SHA256_ARM64={ARM64_SHA}\n"
    )


def _errors(tmp_path: Path, dockerfile: str, proxmox: str | None = None) -> list[str]:
    report = gate.Report()
    docker = tmp_path / "Dockerfile"
    docker.write_text(dockerfile, encoding="utf-8")
    gate.check_dockerfile(docker, report)
    if proxmox is not None:
        script = tmp_path / "build-proxmox-ct.sh"
        script.write_text(proxmox, encoding="utf-8")
        gate.check_proxmox_script(script, docker, report)
    return report.errors


# ------------------------------------------------------------- the happy path

def test_repo_dockerfile_and_ct_builder_pass():
    report = gate.Report()
    gate.check_dockerfile(_REPO / "Dockerfile", report)
    gate.check_proxmox_script(_REPO / "build-proxmox-ct.sh", _REPO / "Dockerfile", report)
    assert report.errors == []


def test_fixture_baseline_passes(tmp_path):
    assert _errors(tmp_path, _dockerfile(), _proxmox()) == []


# ------------------------------------------------- (1) immutable-ref, (2) hashed

def test_floating_latest_release_is_rejected(tmp_path):
    # The exact regression of #105: `latest` is a mutable ref whose assets are
    # replaced in place, so two builds of one commit embed different binaries.
    errors = _errors(tmp_path, _dockerfile(release="latest"), _proxmox())
    assert any("FFMPEG_RELEASE" in e for e in errors)


def test_latest_asset_name_is_rejected(tmp_path):
    errors = _errors(
        tmp_path,
        _dockerfile(amd64_tarball="ffmpeg-n7.1-latest-linux64-gpl-7.1.tar.xz"),
        _proxmox(),
    )
    assert any("FFMPEG_BUILD_AMD64" in e for e in errors)


def test_empty_checksum_is_rejected(tmp_path):
    errors = _errors(tmp_path, _dockerfile(arm64_sha=""), _proxmox())
    assert any("FFMPEG_SHA256_ARM64" in e and "not a 64-char" in e for e in errors)


def test_malformed_checksum_is_rejected(tmp_path):
    errors = _errors(tmp_path, _dockerfile(amd64_sha="deadbeef"), _proxmox())
    assert any("FFMPEG_SHA256_AMD64" in e for e in errors)


def test_missing_arg_declaration_is_rejected(tmp_path):
    dockerfile = _dockerfile().replace("ARG FFMPEG_SHA256_ARM64=" + ARM64_SHA + "\n", "", 1)
    errors = _errors(tmp_path, dockerfile, _proxmox())
    assert any("ARG FFMPEG_SHA256_ARM64" in e for e in errors)


# ------------------------------------------------------------------ (3) verified

def test_unverified_download_is_rejected(tmp_path):
    # A committed hash nobody checks is decoration, not a pin.
    errors = _errors(tmp_path, _dockerfile(verify=False), _proxmox())
    assert any("never verified" in e for e in errors)


def test_missing_empty_checksum_guard_is_rejected(tmp_path):
    # Without the guard, dropping the pin silently downgrades to no pin.
    errors = _errors(tmp_path, _dockerfile(empty_guard=False), _proxmox())
    assert any("empty-checksum guard" in e for e in errors)


# ------------------------------------------------------------------- (4) labelled

def test_final_stage_must_repeat_the_fetch_pins(tmp_path):
    errors = _errors(tmp_path, _dockerfile(final_release="latest"), _proxmox())
    assert any("disagrees with the fetcher's" in e for e in errors)


def test_missing_hash_label_is_rejected(tmp_path):
    dockerfile = _dockerfile().replace(
        '      org.feedBack.ffmpeg.sha256.arm64="${FFMPEG_SHA256_ARM64}"\n', ""
    )
    errors = _errors(tmp_path, dockerfile, _proxmox())
    assert any("sha256.arm64" in e for e in errors)


def test_all_labels_removed_is_rejected(tmp_path):
    errors = _errors(tmp_path, _dockerfile(labels=False), _proxmox())
    assert sum("not provenance" in e for e in errors) == 5


# -------------------------------------------------------------------- (5) mirrored

def test_proxmox_release_drift_is_rejected(tmp_path):
    errors = _errors(tmp_path, _dockerfile(), _proxmox(release="autobuild-2026-06-30-13-34"))
    assert any("disagrees with the Dockerfile's" in e for e in errors)


def test_proxmox_hash_drift_is_rejected(tmp_path):
    errors = _errors(tmp_path, _dockerfile(), _proxmox(amd64_sha="0" * 64))
    assert any("FFMPEG_SHA256_AMD64" in e for e in errors)


def test_missing_fetcher_stage_is_reported(tmp_path):
    dockerfile = _dockerfile().replace("AS ffmpeg-fetcher", "AS something-else")
    errors = _errors(tmp_path, dockerfile, _proxmox())
    assert any("no build stage" in e for e in errors)


def test_report_collects_every_failure_not_just_the_first(tmp_path):
    errors = _errors(tmp_path, _dockerfile(release="latest", amd64_sha=""), _proxmox())
    assert len(errors) >= 2


def test_main_reports_nonzero_on_a_bad_dockerfile(tmp_path, monkeypatch):
    bad = tmp_path / "Dockerfile"
    bad.write_text(_dockerfile(release="latest"), encoding="utf-8")
    (tmp_path / "build-proxmox-ct.sh").write_text(_proxmox(), encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    assert gate.main([]) == 1


def test_main_reports_zero_on_the_repo_tree(monkeypatch):
    monkeypatch.chdir(_REPO)
    assert gate.main([]) == 0
