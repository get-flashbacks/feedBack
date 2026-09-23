"""Tests for the fee[dB]ack v0.3.0 player profile, unified XP, and streak.

Uses an isolated CONFIG_DIR per test (fresh meta.db) and FastAPI's TestClient.
"""

import importlib
import sys

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def server(tmp_path, monkeypatch, isolate_logging):
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("FEEDBACK_SKIP_STARTUP_TASKS", "1")
    sys.modules.pop("server", None)
    srv = importlib.import_module("server")
    try:
        yield srv
    finally:
        conn = getattr(getattr(srv, "meta_db", None), "conn", None)
        if conn is not None:
            getattr(__import__("sys").modules.get("server"), "_join_background_db_threads", lambda: None)()
            conn.close()
        sys.modules.pop("server", None)


@pytest.fixture()
def client(server):
    return TestClient(server.app)


# ── Profile + onboarding ─────────────────────────────────────────────────────

def test_fresh_profile_not_onboarded(client):
    r = client.get("/api/profile")
    assert r.status_code == 200
    body = r.json()
    assert body == {"display_name": None, "avatar_url": None, "player_hash": None,
                    "onboarded": False, "cosmetics": {}}


def test_post_profile_onboards_and_hashes(client):
    r = client.post("/api/profile", json={"display_name": "  Metsamies  "})
    assert r.status_code == 200
    body = r.json()
    assert body["display_name"] == "Metsamies"   # trimmed
    assert body["onboarded"] is True
    assert body["player_hash"] and len(body["player_hash"]) == 64


def test_player_hash_stable_across_rename(client):
    client.post("/api/profile", json={"display_name": "First"})
    h1 = client.get("/api/profile").json()["player_hash"]
    client.post("/api/profile", json={"display_name": "Renamed"})
    h2 = client.get("/api/profile").json()["player_hash"]
    assert h1 == h2
    assert client.get("/api/profile").json()["display_name"] == "Renamed"


@pytest.mark.parametrize("name", ["", " ", "x" * 33])
def test_post_profile_rejects_bad_name(client, name):
    r = client.post("/api/profile", json={"display_name": name})
    assert r.status_code == 400


def test_default_avatar_validation(client):
    avatars = client.get("/api/profile/avatars").json()
    assert avatars, "bundled avatars should be listed"
    good = avatars[0]["name"]
    r = client.post("/api/profile", json={"display_name": "A", "avatar": {"type": "default", "value": good}})
    assert r.status_code == 200
    assert r.json()["avatar_url"] == f"/static/v3/avatars/{good}"
    # Unknown default rejected
    r2 = client.post("/api/profile", json={"display_name": "A", "avatar": {"type": "default", "value": "../etc/passwd"}})
    assert r2.status_code == 400


def test_unknown_upload_reference_rejected(client):
    r = client.post("/api/profile", json={"display_name": "A", "avatar": {"type": "upload", "value": "/api/profile/avatar/nope.png"}})
    assert r.status_code == 400


# ── Unified XP ───────────────────────────────────────────────────────────────

def test_xp_award_and_progress(client, server):
    from xp import xp_for_run
    r = client.post("/api/xp/award", json={"source": "song_play", "amount": xp_for_run(250)})
    assert r.status_code == 200
    body = r.json()
    assert body["xp"] == 158 and body["level"] == 2
    # progress endpoint matches
    prog = client.get("/api/profile/progress").json()
    assert prog["xp"] == 158 and prog["level"] == 2


def test_xp_award_rejects_negative(client):
    assert client.post("/api/xp/award", json={"amount": -5}).status_code == 400
    assert client.post("/api/xp/award", json={"amount": "x"}).status_code == 400


def test_seed_xp_once(server):
    db = server.meta_db
    assert db.get_xp() == 0
    assert db.seed_xp_once(500, "minigames") is True
    assert db.get_xp() == 500
    # second seed is a no-op
    assert db.seed_xp_once(999, "minigames") is False
    assert db.get_xp() == 500


def test_seed_skipped_when_store_nonempty(server):
    db = server.meta_db
    db.award_xp(100)
    assert db.seed_xp_once(500, "minigames") is False
    assert db.get_xp() == 100


# ── Streak ───────────────────────────────────────────────────────────────────

def test_streak_transitions(server):
    db = server.meta_db
    assert db.record_active_day("2026-06-02") == {"current_streak": 1, "best_streak": 1, "last_active_date": "2026-06-02"}
    # consecutive day → +1
    assert db.record_active_day("2026-06-03")["current_streak"] == 2
    # same day → unchanged
    assert db.record_active_day("2026-06-03")["current_streak"] == 2
    # gap → reset to 1, best preserved
    after_gap = db.record_active_day("2026-06-06")
    assert after_gap["current_streak"] == 1
    assert after_gap["best_streak"] == 2


def test_progress_includes_streak(client, server):
    server.meta_db.record_active_day("2026-06-02")
    server.meta_db.record_active_day("2026-06-03")
    prog = client.get("/api/profile/progress").json()
    assert prog["current_streak"] == 2 and prog["best_streak"] == 2


# ── Codex-preflight regression: wrong-typed JSON fields are 400, not 500 ──────

def test_profile_wrong_typed_fields_are_400(client):
    # Non-string display_name / non-dict avatar / non-string avatar.value must
    # validate to 400 rather than raise AttributeError → 500.
    assert client.post("/api/profile", json={"display_name": 1}).status_code == 400
    assert client.post("/api/profile", json={"display_name": "Ok", "avatar": [1, 2]}).status_code == 400
    assert client.post("/api/profile",
                       json={"display_name": "Ok", "avatar": {"type": "default", "value": 5}}).status_code == 400


def test_avatar_upload_non_string_image_is_400(client):
    assert client.post("/api/profile/avatar", json={"image": 123}).status_code == 400
    assert client.post("/api/profile/avatar", json={"image": []}).status_code == 400


# ── Multiple profiles (feedBack#swap-profiles) ───────────────────────────────

def test_fresh_install_has_one_profile(client):
    profiles = client.get("/api/profiles").json()["profiles"]
    assert len(profiles) == 1
    assert profiles[0]["id"] == 1
    assert profiles[0]["active"] is True


def test_create_and_activate_profile(client):
    client.post("/api/profile", json={"display_name": "Alice"})
    r = client.post("/api/profiles", json={"display_name": "Bob"})
    assert r.status_code == 200
    bob = r.json()["created"]
    assert bob["display_name"] == "Bob"
    assert bob["active"] is False

    profiles = client.get("/api/profiles").json()["profiles"]
    assert {p["id"] for p in profiles} == {1, bob["id"]}
    assert [p["active"] for p in profiles if p["id"] == 1] == [True]

    r2 = client.post(f"/api/profiles/{bob['id']}/activate")
    assert r2.status_code == 200
    profiles = r2.json()["profiles"]
    assert next(p for p in profiles if p["id"] == bob["id"])["active"] is True
    assert next(p for p in profiles if p["id"] == 1)["active"] is False
    # /api/profile now reads Bob, not the profile-1 identity set above.
    assert client.get("/api/profile").json()["display_name"] == "Bob"


def test_activate_unknown_profile_is_404(client):
    assert client.post("/api/profiles/999/activate").status_code == 404


@pytest.mark.parametrize("name", ["", " ", "x" * 33])
def test_create_profile_rejects_bad_name(client, name):
    assert client.post("/api/profiles", json={"display_name": name}).status_code == 400


def test_profile_data_isolated_across_switch(client, server):
    """Identity, XP, and song stats for profile A must be invisible from
    profile B, and untouched by switching back and forth."""
    from xp import xp_for_run

    server.meta_db.put("songA.xml", 0, 0, {})  # register in the library, or
    # /api/stats/best hides it regardless of profile (dead-song filter).
    client.post("/api/profile", json={"display_name": "Alice"})
    client.post("/api/xp/award", json={"source": "song_play", "amount": xp_for_run(250)})
    stats1 = client.post("/api/stats", json={"filename": "songA.xml", "arrangement": 0,
                                             "score": 9000, "accuracy": 0.9})
    assert stats1.status_code == 200
    alice_xp = client.get("/api/profile/progress").json()["xp"]
    assert alice_xp > 0

    bob = client.post("/api/profiles", json={"display_name": "Bob"}).json()["created"]
    client.post(f"/api/profiles/{bob['id']}/activate")

    assert client.get("/api/profile").json()["display_name"] == "Bob"
    assert client.get("/api/profile/progress").json()["xp"] == 0
    assert client.get("/api/stats/best").json() == {}

    client.post("/api/profiles/1/activate")
    assert client.get("/api/profile").json()["display_name"] == "Alice"
    assert client.get("/api/profile/progress").json()["xp"] == alice_xp
    assert client.get("/api/stats/best").json() == {"songA.xml": pytest.approx(0.9)}


def test_delete_active_profile_is_rejected(client):
    client.post("/api/profiles", json={"display_name": "Bob"})
    r = client.delete("/api/profiles/1")  # profile 1 is still active
    assert r.status_code == 400


def test_delete_only_remaining_profile_is_rejected(client):
    # Only profile 1 exists — deleting it would leave zero profiles.
    assert client.delete("/api/profiles/1").status_code == 400


def test_delete_profile_removes_its_data(client):
    client.post("/api/profile", json={"display_name": "Alice"})
    bob = client.post("/api/profiles", json={"display_name": "Bob"}).json()["created"]
    client.post(f"/api/profiles/{bob['id']}/activate")
    client.post("/api/xp/award", json={"amount": 50})
    client.post("/api/profiles/1/activate")

    r = client.delete(f"/api/profiles/{bob['id']}")
    assert r.status_code == 200
    profiles = r.json()["profiles"]
    assert {p["id"] for p in profiles} == {1}
    assert client.post(f"/api/profiles/{bob['id']}/activate").status_code == 404
