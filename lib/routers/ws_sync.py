"""Session-sync relay WebSocket — /ws/sync/{session_id} (feedBack#1030).

A deliberately dumb fan-out room: a JSON text frame received from one client
is forwarded verbatim to every OTHER client connected to the same session id.
The server interprets nothing beyond the limits below — message schemas are
owned entirely by consumers. First consumer: splitscreen's LAN follower mode
(feedBack-plugin-splitscreen#21), which relays playhead/playstate/song-change
frames from a host window to view-only followers on other LAN devices.

Design points (full spec in the issue):

- Rooms are created on first join and garbage-collected when the last socket
  leaves. No history, no replay, no persistence — a late joiner simply waits
  for the next frame. Consumers that need state on join re-send it themselves
  (splitscreen answers every follower ``hello`` with a fresh ``config``).
- That statelessness is what makes consumer crash-recovery work: a host that
  relaunches and rejoins the same session id resumes publishing to its
  reconnecting subscribers with no server-side coordination, and an idle room
  is indistinguishable from a nonexistent one.
- ``session_id`` is client-generated and opaque (``[A-Za-z0-9_-]{4,64}``);
  consumers pick their own id policy (splitscreen uses a short typeable,
  persistent room key).
- DoS hygiene for a port that may be LAN-exposed: frame-size cap, per-room and
  total-room caps, and a per-socket inbound token-bucket rate cap. Over-limit
  sockets are closed with a policy code; the room carries on. A peer that dies
  mid-fan-out is dropped without wedging delivery to the rest.
- A per-source-IP connection-attempt rate cap (feedBack-plugin-splitscreen#26)
  bounds how fast one address can try session ids — the room key is a
  discovery/typo-safety mechanism, not a secret, so this doesn't make guessing
  impossible, but it keeps a scan from being cheap on a LAN-exposed port. It
  does not protect against a distributed scan from many source addresses.
"""

import asyncio
import logging
import re
import time

from fastapi import APIRouter, WebSocket

log = logging.getLogger("feedBack.server")

router = APIRouter()

_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]{4,64}$")

# Limits. Sized generously above the first consumer's needs (splitscreen
# publishes time frames at ~15-20 Hz to a handful of viewers) while bounding
# what an open LAN port can be made to do. All module-level so tests (and a
# desperate operator) can override them.
MAX_FRAME_BYTES = 16 * 1024
MAX_CLIENTS_PER_ROOM = 16
MAX_ROOMS = 32
RATE_MSGS_PER_SEC = 120.0  # sustained inbound frames per socket
RATE_BURST = 240.0  # token-bucket burst headroom
# Per-source-IP connection-attempt cap: sized to comfortably allow a handful
# of legitimate near-simultaneous joins (a host reconnecting after a crash,
# several devices behind the same NAT/proxy joining at once) while making a
# room-key scan slow to run from a single address. Deliberately generous —
# this is DoS/scan-cost hygiene, not the security boundary; see the module
# docstring.
CONN_RATE_PER_SEC = 5.0
CONN_BURST = 15.0
# A peer that stops draining its socket would leave send_text() pending
# forever — and since publishers await the fan-out gather, one stalled peer
# would stall every publisher's receive loop behind it. Bounding the send
# turns the stall into an eviction through the normal failed-send drop path.
SEND_TIMEOUT_SECONDS = 5.0

# RFC 6455 close codes.
_WS_UNSUPPORTED_DATA = 1003  # binary frame on a text-only relay
_WS_POLICY_VIOLATION = 1008  # invalid session id / rate cap exceeded
_WS_MSG_TOO_BIG = 1009
_WS_TRY_AGAIN_LATER = 1013  # room or server at capacity

# session_id → {socket: per-socket send lock}. The lock serializes concurrent
# fan-out sends to the same peer (two publishers relaying at once must not
# interleave writes on a third socket's transport).
_rooms: dict[str, dict[WebSocket, asyncio.Lock]] = {}

# source IP → (tokens, last_refill_monotonic) for the connection-attempt cap.
# Unbounded-growth note: entries are never evicted, so a very large number of
# distinct source IPs over the server's lifetime would grow this dict — an
# accepted tradeoff for a LAN-facing relay with a small expected client
# population, matching this module's existing preference for simple
# in-memory state (module-level, test/operator overridable) over a bounded
# cache.
_conn_buckets: dict[str, tuple[float, float]] = {}


def _client_ip(websocket: WebSocket) -> str:
    client = websocket.client
    return client.host if client is not None else "unknown"


def _conn_rate_allowed(ip: str) -> bool:
    now = time.monotonic()
    tokens, last_refill = _conn_buckets.get(ip, (CONN_BURST, now))
    tokens = min(CONN_BURST, tokens + (now - last_refill) * CONN_RATE_PER_SEC)
    # A rejected attempt must not itself consume a token — otherwise a
    # reconnect burst against an already-empty bucket drives tokens further
    # negative each try, extending the lockout well past CONN_BURST's
    # intended recovery time instead of just waiting it out.
    if tokens < 1.0:
        _conn_buckets[ip] = (tokens, now)
        return False
    _conn_buckets[ip] = (tokens - 1.0, now)
    return True


async def _send_locked(peer: WebSocket, lock: asyncio.Lock, text: str) -> None:
    async with lock:
        await asyncio.wait_for(peer.send_text(text), timeout=SEND_TIMEOUT_SECONDS)


@router.websocket("/ws/sync/{session_id}")
async def sync_ws(websocket: WebSocket, session_id: str):
    """Join the fan-out room *session_id*; relay every inbound text frame."""
    await websocket.accept()

    if not _conn_rate_allowed(_client_ip(websocket)):
        await websocket.close(code=_WS_TRY_AGAIN_LATER, reason="connection rate exceeded")
        return

    if not _SESSION_ID_RE.fullmatch(session_id):
        await websocket.close(code=_WS_POLICY_VIOLATION, reason="invalid session id")
        return

    # Capacity checks and insertion run with no await between them, so
    # concurrent joiners on the event loop can't race past the caps.
    room = _rooms.get(session_id)
    if room is None:
        if len(_rooms) >= MAX_ROOMS:
            await websocket.close(code=_WS_TRY_AGAIN_LATER, reason="too many active sessions")
            return
        room = _rooms[session_id] = {}
        log.debug("ws_sync: room %s created", session_id)
    elif len(room) >= MAX_CLIENTS_PER_ROOM:
        await websocket.close(code=_WS_TRY_AGAIN_LATER, reason="session full")
        return
    room[websocket] = asyncio.Lock()

    tokens = RATE_BURST
    last_refill = time.monotonic()

    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break
            text = message.get("text")
            if text is None:
                await websocket.close(code=_WS_UNSUPPORTED_DATA, reason="text frames only")
                break
            if len(text.encode("utf-8", errors="ignore")) > MAX_FRAME_BYTES:
                await websocket.close(code=_WS_MSG_TOO_BIG, reason="frame too large")
                break

            now = time.monotonic()
            tokens = min(RATE_BURST, tokens + (now - last_refill) * RATE_MSGS_PER_SEC)
            last_refill = now
            tokens -= 1.0
            if tokens < 0:
                await websocket.close(code=_WS_POLICY_VIOLATION, reason="rate cap exceeded")
                break

            peers = [(ws, lock) for ws, lock in room.items() if ws is not websocket]
            if not peers:
                continue
            results = await asyncio.gather(
                *(_send_locked(ws, lock, text) for ws, lock in peers),
                return_exceptions=True,
            )
            # A peer that failed mid-send is dropped from the room here; its
            # own handler finishes cleanup (the finally below) when its
            # receive loop observes the disconnect.
            for (peer, _lock), result in zip(peers, results):
                if isinstance(result, Exception):
                    room.pop(peer, None)
    finally:
        room.pop(websocket, None)
        # Guard against deleting a NEW room another joiner created after this
        # one emptied (only possible for a dict that is no longer ours).
        if not room and _rooms.get(session_id) is room:
            del _rooms[session_id]
            log.debug("ws_sync: room %s closed", session_id)
