"""Host-version comparison for the plugin `minHost` floor (feedBack#133).

`minHost` is a *diagnostic*, never a gate: no plugin is blocked, skipped,
or degraded on a mismatch — the loader warns once at startup and the
mismatch is recorded on `/api/plugins` and in the diagnostics bundle.
Feature detection (`docs/plugin-host-compat.md`) stays the mechanism
plugins use to adapt; `minHost` only names the gap for humans.

Two pieces live here so backend and frontend-adjacent code share one
definition:

* :func:`compare_host_versions` — prerelease-aware semver ordering.
  Plain string comparison mishandles the prereleases this host ships
  (``0.3.0-alpha.2`` vs ``0.3.0-alpha.10``), so numeric prerelease
  identifiers compare numerically and a release always sorts after its
  own prereleases.
* :func:`classify_min_host` — the issue's three value classes, plus an
  explicit ``invalid`` bucket:

  - ``unset`` — absent, blank, or non-string: behaves exactly as today.
  - ``placeholder`` — the ``1.0.0`` values existing manifests carry,
    which match no real dependency: likewise ignored, but labelled.
  - ``real`` — a parseable bare version: compared against the host.
  - ``invalid`` — anything else (ranges, prefixes like ``>=``): ignored
    with a one-time warning so a typo can't silently become a floor.

No third-party dependency (``packaging`` is not in requirements.txt):
the parser is a small, strict semver-core + prerelease implementation.
Build metadata (``+...``) is accepted and ignored per semver §10.
"""

from __future__ import annotations

import re

# The placeholder existing manifests carry. It predates any real
# dependency, so enforcing it would be enforcing a wrong value —
# per #133 it is labelled but never acted on.
PLACEHOLDER_VERSIONS = frozenset({"1.0.0"})

# A bare version: optional leading v/=, numeric dotted core, optional
# -prerelease and +build. Anything else (ranges, constraints, text)
# is `invalid`, not `real`.
_VERSION_RE = re.compile(
    r"^[vV=]?\s*"
    r"(?P<core>\d+(?:\.\d+)*)"
    r"(?:-(?P<pre>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
    r"(?:\+(?P<build>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
    r"\s*$"
)


def _parse(version: str) -> tuple[list[int], list[str | int]] | None:
    """Parse a bare version into (core, prerelease-ids), or None.

    Core parts are ints; prerelease identifiers are ints when they are
    all digits (semver §9: numeric identifiers compare numerically) and
    strings otherwise. Build metadata is validated but discarded.
    """
    match = _VERSION_RE.match(version.strip()) if isinstance(version, str) else None
    if not match:
        return None
    core = [int(part) for part in match.group("core").split(".")]
    pre: list[str | int] = []
    raw_pre = match.group("pre")
    if raw_pre is not None:
        for ident in raw_pre.split("."):
            # Leading-zero numeric identifiers are technically invalid
            # semver; accept-but-compare-numerically is friendlier than
            # rejecting a floor over a leading zero.
            pre.append(int(ident) if ident.isdigit() else ident)
    return core, pre


def compare_host_versions(a: str, b: str) -> int:
    """Order two bare versions: -1 if a < b, 0 if equal, 1 if a > b.

    Semver §11 precedence: core compares numerically left-to-right
    (missing parts are zero, so ``0.3`` == ``0.3.0``); a version with
    no prerelease sorts after the same core with one; prerelease
    identifier lists compare element-wise with numeric identifiers
    lower than alphanumeric ones, then fall back to length.

    Raises :class:`ValueError` when either side is not a bare version —
    callers must :func:`classify_min_host` first (or catch) so a bad
    manifest value can never crash the loader.
    """
    parsed_a = _parse(a)
    parsed_b = _parse(b)
    if parsed_a is None:
        raise ValueError(f"not a bare version: {a!r}")
    if parsed_b is None:
        raise ValueError(f"not a bare version: {b!r}")
    core_a, pre_a = parsed_a
    core_b, pre_b = parsed_b
    width = max(len(core_a), len(core_b))
    core_a += [0] * (width - len(core_a))
    core_b += [0] * (width - len(core_b))
    if core_a != core_b:
        return -1 if core_a < core_b else 1
    if not pre_a and not pre_b:
        return 0
    # A release sorts after any prerelease of the same core.
    if not pre_a:
        return 1
    if not pre_b:
        return -1
    for ident_a, ident_b in zip(pre_a, pre_b):
        if ident_a == ident_b:
            continue
        num_a = isinstance(ident_a, int)
        num_b = isinstance(ident_b, int)
        if num_a and num_b:
            return -1 if ident_a < ident_b else 1
        # Numeric identifiers sort below alphanumeric ones (semver §11).
        if num_a:
            return -1
        if num_b:
            return 1
        return -1 if ident_a < ident_b else 1
    if len(pre_a) == len(pre_b):
        return 0
    return -1 if len(pre_a) < len(pre_b) else 1


def classify_min_host(raw) -> str:
    """Bucket a raw manifest ``minHost`` value.

    ``unset`` (absent/blank/non-string), ``placeholder`` (``1.0.0``),
    ``real`` (parseable bare version), or ``invalid`` (anything else).
    Only ``real`` values are ever compared against the host.
    """
    if not isinstance(raw, str) or not raw.strip():
        return "unset"
    text = raw.strip()
    if text in PLACEHOLDER_VERSIONS:
        return "placeholder"
    return "real" if _parse(text) is not None else "invalid"


def min_host_status(min_host, host_version: str) -> str:
    """Full per-plugin status: one of ``unset``, ``placeholder``,
    ``invalid``, ``ok``, or ``unmet``.

    ``unmet`` means the manifest declares a real floor above the
    running host. An unparseable *host* version fails open to ``ok`` —
    a diagnostic must never cry mismatch against a version it cannot
    read (``APP_VERSION`` overrides and ``unknown`` fallbacks exist).
    """
    kind = classify_min_host(min_host)
    if kind != "real":
        return kind
    try:
        return "ok" if compare_host_versions(host_version, min_host) >= 0 else "unmet"
    except (ValueError, TypeError, AttributeError):
        return "ok"


def describe_min_host_gap(plugin_id: str, min_host, host_version: str) -> str:
    """Human diagnostic for an unmet floor: what plugin, what it needs,
    what the host is. Used for the startup log warning and the console
    warning; kept here so both read identically."""
    return (
        f"Plugin {plugin_id!r} declares minHost {min_host!r} but the host "
        f"is at {host_version!r} — loading anyway (minHost is diagnostic-only; "
        f"prefer feature detection, see docs/plugin-host-compat.md)."
    )
