"""Tests for the `minHost` floor diagnostic (feedBack#133).

`minHost` is diagnostic-only: no plugin is ever blocked, skipped, or
degraded on a mismatch. These tests cover the prerelease-aware version
comparison, the unset/placeholder/real/invalid value classes, the
loader's warn-once-but-load-anyway behavior, the `/api/plugins` surface,
and the diagnostics-bundle fields.
"""

import io
import json
import logging
import zipfile

import pytest

import diagnostics_bundle as db
from host_versions import (
    classify_min_host,
    compare_host_versions,
    describe_min_host_gap,
    min_host_status,
)


HOST = "0.3.0-alpha.2"


# ── comparison ──────────────────────────────────────────────────────────


@pytest.mark.parametrize(("a", "b", "want"), [
    # The issue's acceptance vectors.
    ("0.3.0-alpha.2", "0.3.0-alpha.10", -1),
    ("0.3.0-alpha.10", "0.3.0", -1),
    ("0.3.0", "0.3.0", 0),
    # Numeric prerelease identifiers compare numerically, not lexically
    # ("alpha.10" > "alpha.2" — plain string order gets this backwards).
    ("1.0.0-alpha.2", "1.0.0-alpha.10", -1),
    ("1.0.0-alpha", "1.0.0-alpha.1", -1),
    # A release sorts after its own prereleases.
    ("1.0.0", "1.0.0-rc.1", 1),
    ("1.0.0-rc.1", "1.0.0", -1),
    # Core compares numerically; missing parts are zero.
    ("0.3", "0.3.0", 0),
    ("1.2.3", "1.2.4", -1),
    ("2.0.0", "10.0.0", -1),
    # Numeric identifiers sort below alphanumeric ones (semver §11).
    ("1.0.0-alpha.1", "1.0.0-alpha.beta", -1),
    ("1.0.0-alpha.beta", "1.0.0-alpha.1", 1),
    # Longer prerelease wins on prefix equality.
    ("1.0.0-alpha", "1.0.0-alpha.1", -1),
    # Cosmetic forms normalize away.
    ("v0.3.0-alpha.2", "0.3.0-alpha.2", 0),
    ("0.3.0+build.5", "0.3.0", 0),
    ("0.3.0-alpha.2+build.5", "0.3.0-alpha.2", 0),
    # Release-tagged builds (VERSION + short SHA) sort after the plain
    # prerelease — so a tagged host still satisfies a plain floor.
    ("0.3.0-alpha.2-e5339c0", "0.3.0-alpha.2", 1),
])
def test_compare_host_versions(a, b, want):
    assert compare_host_versions(a, b) == want
    assert compare_host_versions(b, a) == -want


def test_compare_host_versions_rejects_non_bare():
    for bad in [">=1.2", "^0.3", "~1.0", "abc", "1.2-beta!", "", "1..0"]:
        with pytest.raises(ValueError):
            compare_host_versions(bad, "1.0.0")
    with pytest.raises(ValueError):
        compare_host_versions("1.0.0", ">=1.2")


def test_compare_host_versions_tolerates_surrounding_whitespace():
    # Cosmetic padding is stripped, not rejected.
    assert compare_host_versions("  0.3.0-alpha.2 ", "0.3.0-alpha.2") == 0


# ── value classes ───────────────────────────────────────────────────────


@pytest.mark.parametrize(("raw", "want"), [
    (None, "unset"),
    ("", "unset"),
    ("   ", "unset"),
    (7, "unset"),
    (["0.3.0"], "unset"),
    ("1.0.0", "placeholder"),
    ("  1.0.0  ", "placeholder"),
    ("0.3.0-alpha.2", "real"),
    ("0.3.0", "real"),
    ("v1.2.3", "real"),
    ("1.0.0-alpha.2-e5339c0", "real"),
    (">=1.2", "invalid"),
    ("^0.3", "invalid"),
    ("abc", "invalid"),
    ("1.2-beta!", "invalid"),
])
def test_classify_min_host(raw, want):
    assert classify_min_host(raw) == want


@pytest.mark.parametrize(("raw", "host", "want"), [
    ("0.3.0-alpha.10", HOST, "unmet"),   # real floor above host → gap
    ("0.3.0-alpha.2", HOST, "ok"),       # real floor satisfied
    ("0.2.0", HOST, "ok"),
    ("0.3.0", HOST, "unmet"),            # release floor above an alpha host
    (None, HOST, "unset"),               # unset behaves exactly as today
    ("", HOST, "unset"),
    ("1.0.0", "0.1.0", "placeholder"),   # placeholder never enforced…
    ("1.0.0", "9.9.9", "placeholder"),   # …even when it would "fail"
    (">=1.2", HOST, "invalid"),
    # An unreadable host fails open: a diagnostic must never cry mismatch
    # against a version it cannot parse (APP_VERSION overrides, "unknown").
    ("9.9.9", "unknown", "ok"),
    ("9.9.9", "", "ok"),
    ("9.9.9", None, "ok"),
])
def test_min_host_status(raw, host, want):
    assert min_host_status(raw, host) == want


def test_describe_min_host_gap_names_plugin_need_and_have():
    msg = describe_min_host_gap("splitscreen", "0.3.0-alpha.10", HOST)
    assert "splitscreen" in msg
    assert "0.3.0-alpha.10" in msg
    assert HOST in msg


# ── loader wiring ───────────────────────────────────────────────────────


def _write_plugin(root, plugin_id, manifest_extra=None):
    d = root / plugin_id
    d.mkdir(parents=True, exist_ok=True)
    manifest = {"id": plugin_id, "name": plugin_id, "routes": "routes.py"}
    manifest.update(manifest_extra or {})
    (d / "plugin.json").write_text(json.dumps(manifest), encoding="utf-8")
    (d / "routes.py").write_text("def setup(app, ctx):\n    pass\n", encoding="utf-8")
    return d


def _run_load(plugins_mod, app, tmp_path, context):
    saved = plugins_mod.PLUGINS_DIR
    plugins_mod.PLUGINS_DIR = tmp_path
    try:
        plugins_mod.load_plugins(app, context)
    finally:
        plugins_mod.PLUGINS_DIR = saved


def test_loader_marks_unmet_but_still_loads(tmp_path, reset_plugin_state, caplog):
    """A real floor above the host warns once naming the gap — and the
    plugin still graduates to ready (diagnostic-only, never a gate)."""
    plugins_mod = reset_plugin_state
    _write_plugin(tmp_path, "needy", {"minHost": "0.3.0-alpha.10"})
    _write_plugin(tmp_path, "fine", {"minHost": "0.3.0-alpha.1"})

    with caplog.at_level(logging.WARNING, logger="feedBack.plugins"):
        _run_load(plugins_mod, type("FakeApp", (), {})(), tmp_path,
                  {"host_version": HOST})

    by_id = {p["id"]: p for p in plugins_mod.LOADED_PLUGINS}
    assert by_id["needy"]["min_host"] == "0.3.0-alpha.10"
    assert by_id["needy"]["min_host_status"] == "unmet"
    assert by_id["fine"]["min_host_status"] == "ok"
    warnings = [r.getMessage() for r in caplog.records
                if r.name == "feedBack.plugins"]
    assert any("needy" in w and "0.3.0-alpha.10" in w and HOST in w for w in warnings), warnings
    assert not any("'fine'" in w or '"fine"' in w for w in warnings), warnings


def test_loader_ignores_placeholder_and_unset_silently(tmp_path, reset_plugin_state, caplog):
    """`1.0.0` placeholders and absent floors behave exactly as today:
    loaded, no warning, labelled but never compared."""
    plugins_mod = reset_plugin_state
    _write_plugin(tmp_path, "old", {"minHost": "1.0.0"})
    _write_plugin(tmp_path, "plain", {})

    with caplog.at_level(logging.WARNING, logger="feedBack.plugins"):
        _run_load(plugins_mod, type("FakeApp", (), {})(), tmp_path,
                  {"host_version": "0.1.0"})

    by_id = {p["id"]: p for p in plugins_mod.LOADED_PLUGINS}
    assert by_id["old"]["min_host_status"] == "placeholder"
    assert by_id["plain"]["min_host_status"] == "unset"
    assert by_id["plain"]["min_host"] is None
    warnings = [r.getMessage() for r in caplog.records
                if r.name == "feedBack.plugins" and "minHost" in r.getMessage()]
    assert warnings == [], warnings


def test_loader_warns_on_invalid_but_still_loads(tmp_path, reset_plugin_state, caplog):
    """An unparseable floor (range, typo) warns once and is ignored —
    it must not silently become a floor, nor block the plugin."""
    plugins_mod = reset_plugin_state
    _write_plugin(tmp_path, "ranged", {"minHost": ">=0.3.0"})

    with caplog.at_level(logging.WARNING, logger="feedBack.plugins"):
        _run_load(plugins_mod, type("FakeApp", (), {})(), tmp_path,
                  {"host_version": HOST})

    by_id = {p["id"]: p for p in plugins_mod.LOADED_PLUGINS}
    assert by_id["ranged"]["min_host_status"] == "invalid"
    warnings = [r.getMessage() for r in caplog.records
                if r.name == "feedBack.plugins" and "minHost" in r.getMessage()]
    assert len(warnings) == 1 and "ranged" in warnings[0]


def test_loader_without_host_version_fails_open(tmp_path, reset_plugin_state, caplog):
    """Callers that pass no host_version (tests, dev reloads) get no
    spurious mismatch: real floors read `ok`."""
    plugins_mod = reset_plugin_state
    _write_plugin(tmp_path, "needy", {"minHost": "9.9.9"})

    with caplog.at_level(logging.WARNING, logger="feedBack.plugins"):
        _run_load(plugins_mod, type("FakeApp", (), {})(), tmp_path, {})

    by_id = {p["id"]: p for p in plugins_mod.LOADED_PLUGINS}
    assert by_id["needy"]["min_host_status"] == "ok"
    warnings = [r.getMessage() for r in caplog.records
                if r.name == "feedBack.plugins" and "minHost" in r.getMessage()]
    assert warnings == [], warnings


def test_api_plugins_surfaces_min_host_status(tmp_path, reset_plugin_state):
    """GET /api/plugins carries min_host + min_host_status for real and
    stubbed entries alike."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    plugins_mod = reset_plugin_state
    _write_plugin(tmp_path, "needy", {"minHost": "0.3.0-alpha.10"})
    _run_load(plugins_mod, type("FakeApp", (), {})(), tmp_path,
              {"host_version": HOST})
    # A stubbed entry built without _nav_entry falls back cleanly.
    plugins_mod.LOADED_PLUGINS.append({
        "id": "stub", "name": "Stub", "nav": None, "type": None,
        "has_screen": False, "has_script": False, "has_settings": False,
        "_manifest": {"minHost": "0.3.0-alpha.10"},
    })

    app = FastAPI()
    plugins_mod.register_plugin_api(app)
    client = TestClient(app)
    try:
        r = client.get("/api/plugins")
        assert r.status_code == 200
        rows = {p["id"]: p for p in r.json()}
        assert rows["needy"]["min_host"] == "0.3.0-alpha.10"
        assert rows["needy"]["min_host_status"] == "unmet"
        assert rows["stub"]["min_host"] == "0.3.0-alpha.10"
        # Unknown host at the API boundary fails open, never a false unmet.
        assert rows["stub"]["min_host_status"] == "ok"
    finally:
        client.close()


# ── diagnostics bundle ──────────────────────────────────────────────────


def _bundle_kwargs(tmp_path, loaded_plugins, version=HOST):
    return dict(
        feedBack_version=version,
        config_dir=tmp_path,
        dlc_dir=None,
        log_file=None,
        loaded_plugins=loaded_plugins,
        include={"system": True, "hardware": False, "logs": False,
                 "console": False, "plugins": False},
        redact=True,
        client_console=None,
        client_hardware=None,
        client_ua=None,
        local_storage=None,
        log=logging.getLogger("test"),
    )


def test_bundle_plugins_carry_min_host_and_status(tmp_path):
    """system/plugins.json records the floor and its status per plugin —
    the what-needs-what the issue asks to be available in the bundle."""
    loaded = [
        {"id": "needy", "name": "Needy", "_manifest": {"minHost": "0.3.0-alpha.10"},
         "min_host_status": "unmet"},
        {"id": "plain", "name": "Plain", "_manifest": {}},
    ]
    zip_bytes, _name, _manifest = db.build_bundle(**_bundle_kwargs(tmp_path, loaded))
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        data = json.loads(zf.read("system/plugins.json"))
    assert data["schema"] == "system.plugins.v1"
    by_id = {p["id"]: p for p in data["plugins"]}
    assert by_id["needy"]["min_host"] == "0.3.0-alpha.10"
    assert by_id["needy"]["min_host_status"] == "unmet"
    assert by_id["plain"]["min_host"] is None
    assert by_id["plain"]["min_host_status"] == "unset"


def test_bundle_reevaluates_entries_predating_the_field(tmp_path):
    """Entries without a loader-computed status are evaluated against the
    bundle's host version instead of failing open to `ok`."""
    loaded = [
        {"id": "legacy", "name": "Legacy",
         "_manifest": {"minHost": "0.3.0-alpha.10"}},
    ]
    zip_bytes, _name, _manifest = db.build_bundle(**_bundle_kwargs(tmp_path, loaded))
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        data = json.loads(zf.read("system/plugins.json"))
    by_id = {p["id"]: p for p in data["plugins"]}
    assert by_id["legacy"]["min_host_status"] == "unmet"
