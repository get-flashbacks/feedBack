"""Regression coverage for sloppak load failures in the highway websocket."""

import asyncio
import importlib
import sys

import pytest


class _CapturingWS:
    def __init__(self):
        self.messages = []
        self.accepted = False
        self.closed = False

    async def accept(self):
        self.accepted = True

    async def send_json(self, data):
        self.messages.append(data)

    async def receive_text(self):
        await asyncio.sleep(0)
        return ""

    async def close(self):
        self.closed = True


@pytest.fixture()
def server(tmp_path, monkeypatch):
    (tmp_path / "dlc").mkdir()
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.setenv("DLC_DIR", str(tmp_path / "dlc"))
    monkeypatch.setenv("FEEDBACK_SKIP_STARTUP_TASKS", "1")
    sys.modules.pop("server", None)
    mod = importlib.import_module("server")
    yield mod, tmp_path / "dlc", tmp_path / "cache"
    conn = getattr(getattr(mod, "meta_db", None), "conn", None)
    if conn is not None:
        getattr(mod, "_join_background_db_threads", lambda: None)()
        conn.close()
    sys.modules.pop("server", None)


def test_sloppak_loader_returning_none_sends_error_without_touching_stems(
    server, monkeypatch
):
    _server, dlc, cache = server
    (dlc / "broken.feedpak").mkdir()

    import appstate
    from routers import ws_highway

    monkeypatch.setattr(appstate, "sloppak_cache_dir", cache)
    monkeypatch.setattr(ws_highway.sloppak_mod, "load_song", lambda *a, **kw: None)

    ws = _CapturingWS()
    asyncio.run(ws_highway.highway_ws(ws, "broken.feedpak", arrangement=0))

    assert ws.accepted is True
    assert ws.closed is True
    assert {"error": "Failed to load sloppak"} in ws.messages
