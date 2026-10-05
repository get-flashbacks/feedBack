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
  Keyed on `websocket.client.host` (the ASGI-layer peer address) with no
  `X-Forwarded-For`/`X-Real-IP` trust: if feedBack is ever deployed behind a
  reverse proxy that doesn't preserve the original client address at that
  layer, every client behind the proxy shares one bucket. Fine for the
  documented direct-LAN deployment; revisit if a supported proxy topology
  needs real client-IP propagation.
- The state behind that cap is bounded, like the rest of this module (#106). A
  bucket idle for a full refill window has every token back, so it is
  indistinguishable from a bucket that was never created and is dropped; a
  hard ceiling then evicts the least-recently-seen addresses, so an address
  rotation flood (a client with a large IPv6 prefix) cannot grow the map past
  `MAX_CONN_BUCKETS`.
"""

import asyncio
import logging
import re
import time
from collections import OrderedDict

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
# docstring. Burst is kept >= MAX_CLIENTS_PER_ROOM so a full room's worth of
# near-simultaneous joins from one shared address (reverse proxy, NAT
# hairpin, several local tabs) can't be rejected purely by this cap while
# the room itself still has space.
CONN_RATE_PER_SEC = 5.0
CONN_BURST = 32.0
# Hard ceiling on how many source IPs the connection-attempt cap remembers at
# once; the least-recently-seen entry is dropped once it is reached. Sized well
# above any plausible client population (the cap is keyed on peer addresses,
# so every NAT/proxy behind the relay can add entries) while keeping the map's
# worst case a fixed few hundred entries rather than one per address ever seen.
# Past the ceiling eviction is not free: it discards the evicted address's
# tokens along with its entry, so an address that is still locked out loses the
# rest of its lockout when unrelated new addresses push it off the end. Size
# this above the deployment's real address population, not as low as memory
# alone would allow.
MAX_CONN_BUCKETS = 256
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
# Bounded two ways (see `_conn_idle_ttl` and `MAX_CONN_BUCKETS`) rather than
# growing one entry per address ever seen: `OrderedDict` so recency is
# explicit, least-recently-seen first.
_conn_buckets: OrderedDict[str, tuple[float, float]] = OrderedDict()


def _client_ip(websocket: WebSocket) -> str:
    client = websocket.client
    return client.host if client is not None else "unknown"


def _conn_idle_ttl() -> float | None:
    """Seconds an unused bucket must sit before it is indistinguishable from a
    missing one.

    A bucket refills at `CONN_RATE_PER_SEC` up to `CONN_BURST`, so once
    `CONN_BURST / CONN_RATE_PER_SEC` has elapsed it holds a full burst either
    way — evicting it there hands out nothing that a first-time address
    wouldn't have received anyway. `None` means no idle interval does that
    (refilling disabled), in which case nothing may be evicted on idleness
    alone: dropping the entry would reset the lockout instead of clearing it.
    """
    if CONN_RATE_PER_SEC <= 0:
        return None
    return CONN_BURST / CONN_RATE_PER_SEC


def _prune_conn_buckets(now: float) -> None:
    """Drop buckets that have refilled to full (and so carry no state)."""
    ttl = _conn_idle_ttl()
    if ttl is None:
        return
    stale = [ip for ip, (_tokens, last_refill) in _conn_buckets.items()
             if now - last_refill >= ttl]
    for ip in stale:
        del _conn_buckets[ip]
    if stale:
        log.debug("ws_sync: evicted %d idle connection-rate bucket(s)", len(stale))


def _conn_rate_allowed(ip: str) -> bool:
    now = time.monotonic()
    entry = _conn_buckets.get(ip)
    if entry is None:
        # A new address costs a sweep of the refilled ones, which is the only
        # growth path for this map — attempts from a known address (the hot
        # path) touch no more than their own bucket.
        _prune_conn_buckets(now)
        tokens, last_refill = CONN_BURST, now
    else:
        tokens, last_refill = entry
        # Recency is what the size ceiling evicts on, so an address that keeps
        # connecting has to move to the back rather than age out behind a
        # flood of one-shot ones.
        _conn_buckets.move_to_end(ip)
    tokens = min(CONN_BURST, tokens + (now - last_refill) * CONN_RATE_PER_SEC)
    # A rejected attempt must not itself consume a token — otherwise a
    # reconnect burst against an already-empty bucket drives tokens further
    # negative each try, extending the lockout well past CONN_BURST's
    # intended recovery time instead of just waiting it out.
    if tokens < 1.0:
        _conn_buckets[ip] = (tokens, now)
        return False
    _conn_buckets[ip] = (tokens - 1.0, now)
    # Bound the map for a client that rotates source addresses: those entries
    # never idle, so only a ceiling holds the growth. Evicted buckets are the
    # least recently *seen* ones, which under that flood are the oldest
    # attempts. Dropping one costs nothing against the flood — such a client is
    # handed a fresh burst per address either way — but it does throw away that
    # address's tokens, so once the address population passes the ceiling an
    # unrelated burst of new addresses can also cut short the lockout of a
    # legitimate address that stopped reconnecting (see the MAX_CONN_BUCKETS
    # comment). Skipping locked-out buckets instead would let a flood hold the
    # ceiling full and lock out every new address, so evicting is the trade
    # worth making.
    while len(_conn_buckets) > MAX_CONN_BUCKETS:
        evicted, _bucket = _conn_buckets.popitem(last=False)
        log.debug("ws_sync: evicted connection-rate bucket for %s at the %d-entry cap",
                  evicted, MAX_CONN_BUCKETS)
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
