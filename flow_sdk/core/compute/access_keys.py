"""Remote control on this machine: its access keys and the window it is open for.

One machine is one hub ComputeNode, so the store is per MACHINE, not per instance:
``<flow home>/remote_control.json`` (0600). Every change is one read-modify-write under a cross-process lock,
which is what makes "on needs an accepted key" hold whichever instance, CLI or agent writes.

Remote control is off unless the owner's passkey answered a challenge this machine made (:func:`new_turn_on`,
then :func:`open_with` once the answer was verified), and then only until ``open_until``. There is no stored
"on": it is derived (:func:`is_on`), so nothing can leave it on past the deadline.

A key the hub lists is **accepted** on its own only when it was added through a request this machine made
(:func:`new_request`) for this machine's node. Any other key is **pending** for ten minutes, waits for
:func:`allow`, and is then dropped — and stays dropped until the person asks again.

Nothing here talks to the hub or reads a clock on its own: callers pass the hub's key list and ``now``.
"""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Optional, TypeVar

from flow_sdk.instances.atomic import locked, read_json, write_json_atomic

STORE_FILE = "remote_control.json"
REQUEST_TTL = timedelta(minutes=10)
PENDING_TTL = timedelta(minutes=10)
CHALLENGE_TTL = timedelta(minutes=5)
#: How long a turn-on may keep remote control open, in hours. The first is the default the UI selects.
HOURS_OPTIONS = (1, 3, 10, 24)
#: Turn-on challenges kept at once; an older one gives way to a new one.
MAX_CHALLENGES = 8

EXPIRED = "expired"
LOCKED = "locked"

ACCEPTED = "accepted"
PENDING = "pending"

#: What a key record keeps of the hub's row. ``public_key`` and ``algorithm`` are what a signature is checked with.
#: A record also keeps ``sign_count``: the counter of the last passkey answer this machine verified.
KEY_FIELDS = ("credential_id", "kind", "label", "code", "public_key", "algorithm", "request_id")

T = TypeVar("T")


class NoAcceptedKey(Exception):
    """Remote control cannot be turned on: this machine has accepted no access key."""


class BadHours(ValueError):
    """The window asked for is not one of :data:`HOURS_OPTIONS`."""


class ChallengeGone(Exception):
    """The turn-on challenge is not live: it was used, its five minutes ran out, or it was never made here."""


def store_path() -> Path:
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    return get_instance_settings().flow_home / STORE_FILE


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat()


def _is_live(expires_at: Any, now: datetime) -> bool:
    try:
        return datetime.fromisoformat(str(expires_at)) > now
    except (ValueError, TypeError):  # TypeError: a stored time without a zone cannot be compared
        return False


# ── the file ─────────────────────────────────────────────────────────────


def _hours(value: Any) -> Optional[int]:
    return value if type(value) is int and value in HOURS_OPTIONS else None


def checked_hours(value: Any) -> int:
    """``value`` when it is one of :data:`HOURS_OPTIONS`. Raises :class:`BadHours` otherwise."""
    if _hours(value) is None:
        raise BadHours(f"hours must be one of {', '.join(map(str, HOURS_OPTIONS))}")
    return value


def _normalized(raw: dict) -> dict:
    """The state in the store's shape. ``on`` is never read from the file: it is derived (:func:`is_on`)."""
    keys = raw.get("keys")
    requests = raw.get("requests")
    dropped = raw.get("dropped")
    challenges = raw.get("challenges")
    open_until = raw.get("open_until")
    last_off = raw.get("last_off")
    return {
        "node_typeid": raw.get("node_typeid") or None,
        "node_name": raw.get("node_name") or None,
        "open_until": open_until if isinstance(open_until, str) and open_until else None,
        "hours": _hours(raw.get("hours")),
        "last_off": last_off if last_off in (EXPIRED, LOCKED) else None,
        "challenges": [
            {"challenge": c["challenge"], "hours": c["hours"], "expires_at": c.get("expires_at")}
            for c in (challenges if isinstance(challenges, list) else [])
            if isinstance(c, dict) and isinstance(c.get("challenge"), str) and _hours(c.get("hours"))
        ],
        "keys": {k: dict(v) for k, v in keys.items() if isinstance(v, dict)} if isinstance(keys, dict) else {},
        "dropped": [str(c) for c in dropped] if isinstance(dropped, list) else [],
        "requests": {str(k): str(v) for k, v in requests.items()} if isinstance(requests, dict) else {},
    }


def read_state(path: Path | None = None) -> dict:
    """The stored state; a missing or unreadable file is a machine with no keys and remote control off."""
    return _normalized(read_json(path or store_path()))


def _update(change: Callable[[dict], T], path: Path | None, now: datetime | None = None) -> tuple[T, dict]:
    """One locked read-modify-write. Answers ``(what the change answered, the state as written)``."""
    path = path or store_path()
    with locked(path.with_name(path.name + ".lock")):
        state = read_state(path)
        result = change(state)
        _settle(state, now or utc_now())
        write_json_atomic(path, state)
    return result, state


def _accepted(state: dict) -> list[dict]:
    return [key for key in state["keys"].values() if key.get("state") == ACCEPTED]


def _settle(state: dict, now: datetime) -> None:
    """The invariants of every write: no accepted key, no remote control; and only live challenges are kept."""
    state["challenges"] = [c for c in state["challenges"] if _is_live(c.get("expires_at"), now)][-MAX_CHALLENGES:]
    if not _accepted(state):
        state["open_until"] = None
        state["last_off"] = None
        state["challenges"] = []


# ── keys ─────────────────────────────────────────────────────────────────


def _key_record(source: dict) -> dict:
    return {field: source.get(field) for field in KEY_FIELDS}


def _sign_count(key: dict) -> int:
    count = key.get("sign_count")
    return count if type(count) is int and count >= 0 else 0


def set_machine_access_key(record: dict, *, now: datetime | None = None, path: Path | None = None) -> dict:
    """Accept ``record`` (``credential_id`` required) as an access key of this machine. Answers the stored record."""
    credential_id = str(record.get("credential_id") or "")
    if not credential_id:
        raise ValueError("an access key needs a credential_id")
    stored = {
        **_key_record(record),
        "credential_id": credential_id,
        "state": ACCEPTED,
        "accepted_at": _iso(now or utc_now()),
        "expires_at": None,
        "sign_count": _sign_count(record),
    }

    def change(state: dict) -> dict:
        state["keys"][credential_id] = stored
        if credential_id in state["dropped"]:
            state["dropped"].remove(credential_id)
        return stored

    return _update(change, path, now)[0]


def machine_access_keys(path: Path | None = None) -> list[dict]:
    """The keys this machine accepted, oldest first."""
    return sorted(_accepted(read_state(path)), key=lambda key: str(key.get("accepted_at") or ""))


def remove_machine_access_key(credential_id: str, *, now: datetime | None = None, path: Path | None = None) -> bool:
    """:func:`remove`, answering whether there was such a key."""
    return remove(credential_id, now=now, path=path) is not None


def remove(credential_id: str, *, now: datetime | None = None, path: Path | None = None) -> dict | None:
    """Forget a key (accepted or pending). The last accepted key going turns remote control off.

    The request it came in through is forgotten with it, so while the hub still lists the key it can only
    come back as pending — never accepted on its own a second time. Answers the new state, None for no such key.
    """

    def change(state: dict) -> bool:
        key = state["keys"].pop(credential_id, None)
        if key is None:
            return False
        state["requests"].pop(str(key.get("request_id") or ""), None)
        if credential_id not in state["dropped"]:
            state["dropped"].append(credential_id)
        return True

    removed, state = _update(change, path, now)
    return state if removed else None


def allow(credential_id: str, *, now: datetime | None = None, path: Path | None = None) -> dict | None:
    """Accept a pending key. Answers the new state; None for no such pending key, or one whose ten minutes ran out."""
    now = now or utc_now()

    def change(state: dict) -> bool:
        key = state["keys"].get(credential_id)
        if not key or key.get("state") != PENDING or not _is_live(key.get("expires_at"), now):
            return False
        key.update(state=ACCEPTED, accepted_at=_iso(now), expires_at=None)
        return True

    allowed, state = _update(change, path, now)
    return state if allowed else None


# ── the window and the node ──────────────────────────────────────────────


def is_on(state: dict, now: datetime) -> bool:
    """Remote control is on only while ``now`` is before ``open_until``, and only with an accepted key."""
    return bool(_accepted(state)) and _is_live(state["open_until"], now)


def live_challenges(state: dict, now: datetime) -> list[str]:
    """The turn-on challenges a passkey answer may still be for."""
    return [c["challenge"] for c in state["challenges"] if _is_live(c.get("expires_at"), now)]


def new_turn_on(hours: Any, now: datetime, *, path: Path | None = None) -> dict:
    """A five-minute, single-use challenge for turning remote control on: ``{challenge, hours, expires_at}``.

    ``challenge`` is 32 random bytes, base64url. Raises :class:`BadHours` for hours outside
    :data:`HOURS_OPTIONS`, and :class:`NoAcceptedKey` (in the same write) when there is no key to answer it.
    """
    made = {
        "challenge": secrets.token_urlsafe(32),
        "hours": checked_hours(hours),
        "expires_at": _iso(now + CHALLENGE_TTL),
    }

    def change(state: dict) -> dict:
        if not _accepted(state):
            raise NoAcceptedKey("add an access key first")
        state["challenges"].append(made)
        return made

    return _update(change, path, now)[0]


def open_with(
    challenge: str,
    now: datetime,
    *,
    credential_id: str,
    sign_count: int | None = None,
    path: Path | None = None,
) -> dict:
    """Use up a live challenge and open remote control for its hours. Answers the new state.

    Call it only after the passkey answer to ``challenge`` was verified. ``credential_id`` is the accepted key
    that answered; its ``sign_count`` is stored with the same write. Raises :class:`ChallengeGone` when the
    challenge is not live (so one answer opens once), :class:`NoAcceptedKey` when that key is no longer accepted.
    """

    def change(state: dict) -> None:
        found = next(
            (c for c in state["challenges"] if c["challenge"] == challenge and _is_live(c.get("expires_at"), now)),
            None,
        )
        if found is None:
            raise ChallengeGone("this request expired, turn on again")
        key = state["keys"].get(credential_id)
        if not key or key.get("state") != ACCEPTED:
            raise NoAcceptedKey("the key that answered is not accepted on this machine")
        if sign_count is not None:
            key["sign_count"] = sign_count
        state["challenges"].remove(found)
        state.update(open_until=_iso(now + timedelta(hours=found["hours"])), hours=found["hours"], last_off=None)

    return _update(change, path, now)[1]


def lock(now: datetime, *, path: Path | None = None) -> dict:
    """Turn remote control off at once, and forget every unanswered turn-on. Answers the new state."""

    def change(state: dict) -> None:
        if state["open_until"]:
            state["last_off"] = LOCKED if is_on(state, now) else EXPIRED
        state["open_until"] = None
        state["challenges"] = []

    return _update(change, path, now)[1]


def expire_if_due(now: datetime, *, path: Path | None = None) -> tuple[dict, bool]:
    """Record that the window ran out. Answers ``(the state, expired)``.

    ``expired`` is true exactly once per window: for the call that turned it off.
    """
    state = read_state(path)
    if not _due(state, now):  # the common case writes nothing
        return state, False

    def change(state: dict) -> bool:
        if not _due(state, now):
            return False
        state.update(open_until=None, last_off=EXPIRED)
        return True

    expired, state = _update(change, path, now)
    return state, expired


def _due(state: dict, now: datetime) -> bool:
    return bool(state["open_until"]) and not _is_live(state["open_until"], now)


def set_node(node_typeid: str, node_name: str | None, *, path: Path | None = None) -> None:
    """Remember the hub node that stands for this machine."""

    def change(state: dict) -> None:
        state["node_typeid"] = node_typeid
        state["node_name"] = node_name or None

    _update(change, path)


# ── requests ─────────────────────────────────────────────────────────────


def new_request(*, now: datetime | None = None, path: Path | None = None) -> dict:
    """A ten-minute request id for adding a key from this machine: ``{id, expires_at}``.

    Asking again also lifts the drop on keys whose ten minutes ran out, so they are offered once more.
    """
    now = now or utc_now()
    request = {"id": secrets.token_urlsafe(24), "expires_at": _iso(now + REQUEST_TTL)}

    def change(state: dict) -> dict:
        state["requests"] = {rid: exp for rid, exp in state["requests"].items() if _is_live(exp, now)}
        state["requests"][request["id"]] = request["expires_at"]
        state["dropped"] = []
        return request

    return _update(change, path, now)[0]


# ── the accept rule ──────────────────────────────────────────────────────


def accept_hub_keys(state: dict, hub_keys: list[dict], node_typeid: str | None, now: datetime) -> dict:
    """The next state given the hub's key list. Pure: nothing is read or written.

    * a stored key the hub no longer lists is removed;
    * a pending key past its ten minutes is dropped, and not offered again until :func:`new_request`;
    * a new key is accepted when it names a live request of this machine AND this machine's node — the request
      is used up by it; any other new key is pending for ten minutes.
    """
    state = _normalized(state)
    listed = {str(key["credential_id"]): key for key in hub_keys if isinstance(key, dict) and key.get("credential_id")}
    requests = {rid: exp for rid, exp in state["requests"].items() if _is_live(exp, now)}
    dropped = [cid for cid in state["dropped"] if cid in listed]
    keys: dict[str, dict] = {}
    for credential_id, key in state["keys"].items():
        if credential_id not in listed:
            continue
        if key.get("state") == PENDING and not _is_live(key.get("expires_at"), now):
            dropped.append(credential_id)
            continue
        hub_key = listed[credential_id]
        keys[credential_id] = {**key, "label": hub_key.get("label"), "code": hub_key.get("code")}
    for credential_id, hub_key in listed.items():
        if credential_id in keys or credential_id in dropped:
            continue
        request_id = str(hub_key.get("request_id") or "")
        own = bool(node_typeid) and hub_key.get("request_node") == node_typeid and request_id in requests
        if own:
            del requests[request_id]
            keys[credential_id] = {
                **_key_record(hub_key), "state": ACCEPTED, "accepted_at": _iso(now), "expires_at": None,
                "sign_count": 0,
            }  # fmt: skip
        else:
            keys[credential_id] = {
                **_key_record(hub_key), "state": PENDING, "accepted_at": None, "expires_at": _iso(now + PENDING_TTL),
                "sign_count": 0,
            }  # fmt: skip
    state.update(keys=keys, dropped=dropped, requests=requests)
    _settle(state, now)
    return state


def apply_hub_keys(hub_keys: list[dict], node_typeid: str | None, now: datetime, *, path: Path | None = None) -> dict:
    """Apply :func:`accept_hub_keys` to the store in one locked write. Answers the new state."""

    def change(state: dict) -> None:
        state.update(accept_hub_keys(state, hub_keys, node_typeid, now))

    return _update(change, path, now)[1]


# ── what the UI is told ──────────────────────────────────────────────────


def accepted_count(state: dict) -> int:
    return len(_accepted(state))


def status_view(state: dict, *, reason: Optional[str], hostname: str, now: datetime) -> dict:
    """The ``Status`` the local routes answer. ``reason`` is why remote control is unavailable here, or None.

    A window whose deadline passed reads as off and expired here, whether or not :func:`expire_if_due` ran yet.
    """
    on = is_on(state, now)
    ran_out = _due(state, now)
    keys = [
        {
            "credential_id": key.get("credential_id"),
            "label": key.get("label"),
            "code": key.get("code"),
            "kind": key.get("kind"),
            "state": key.get("state"),
            "accepted_at": key.get("accepted_at"),
            "expires_at": key.get("expires_at"),
        }
        for key in state["keys"].values()
        if key.get("state") == ACCEPTED or _is_live(key.get("expires_at"), now)
    ]
    keys.sort(key=lambda key: (key["state"] != ACCEPTED, str(key["accepted_at"] or key["expires_at"] or "")))
    live = sorted((exp, rid) for rid, exp in state["requests"].items() if _is_live(exp, now))
    return {
        "available": reason is None,
        "reason": reason,
        "on": on,
        "open_until": state["open_until"] if on else None,
        "hours": state["hours"],
        "last_off": EXPIRED if ran_out else state["last_off"],
        "hours_options": list(HOURS_OPTIONS),
        "node_typeid": state["node_typeid"],
        "machine_name": (state["node_name"] or "").lstrip("@") or hostname,
        "keys": keys,
        "request": {"id": live[-1][1], "expires_at": live[-1][0]} if live else None,
    }
