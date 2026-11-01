"""Secured transfer — a credential's values from one member to another, end to end (``docs/secret_share.md``).

This install's keys live in the OS keychain (never the hub, never the consent-gated vault). Its public half is
published to the hub (``<user>/device_key``); other members' keys are read ONLY through a members action of the
conversation (``conversation/<id>/list_members/device_keys``) and pinned on first use, following a rotation only
through its signed chain (``sealed.accept_advert``).

On the hub a transfer is two hub-only FlowMessage kinds (``FlowMessageKind.hub_only``): ``sealed_value`` — the
envelope in ``metadata`` — and ``sealed_ack`` — "filled" / "declined", no value. The sender deletes the envelope once
every recipient answered. Values are read from this computer's store, sealed in memory, and written on the receiver
through the credential writer as given; nothing here logs, returns or stores a value.
"""

from __future__ import annotations

import json
import logging
import socket
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional, Protocol

from flow_sdk.builtin.flow_message import FlowMessageKind
from flow_sdk.schema.data_spec.sealed_value_spec import DeviceKeyAdvertSpec, SealedValueSpec
from flow_sdk.secrets.sealed import (
    DeviceKeyPair,
    DeviceKeyring,
    SealedError,
    accept_advert,
    make_advert,
    open_sealed,
    seal,
)

logger = logging.getLogger(__name__)

SEALED_KIND = FlowMessageKind.SEALED_VALUE.value
ACK_KIND = FlowMessageKind.SEALED_ACK.value
PENDING_KIND = FlowMessageKind.SEALED_PENDING.value
REQUEST_KIND = FlowMessageKind.SEALED_REQUEST.value
NOTE_KIND = FlowMessageKind.SEALED_NOTE.value
#: A device rotates its keys this often; the retired keys stay until what was sealed to them expired.
ROTATE_AFTER = timedelta(days=30)
DEVICE_KEYS = "device_keys"
FILLED, DECLINED = "filled", "declined"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _hub():
    from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415
    from flow_sdk.db.drivers.db_base_record import BuiltinEntityType  # noqa: PLC0415

    return HubProxy, BuiltinEntityType


async def on_sealed_arrival(conversation_id: str) -> None:
    """A hub-only secured-transfer message arrived live: answer any "get it" request this install owes (the sender
    already approved the share), then refresh the conversation so its card re-reads the hub."""
    try:
        await answer_requests(conversation_id)
    except Exception:  # noqa: BLE001 — retried by the next arrival and by the catch-up after sign-in
        logger.info("[sealed] could not answer requests in %s", conversation_id, exc_info=True)
    try:
        from flow_sdk.builtin.conversation import Conversation  # noqa: PLC0415

        conv = await Conversation.get_one({"id": conversation_id})
        if conv is not None:
            await conv.notify_updated()
    except Exception:  # noqa: BLE001 — a missed refresh is repaired by the next open
        logger.debug("[sealed] could not refresh conversation %s", conversation_id, exc_info=True)


# ── this install's keys ─────────────────────────────────────────────────────


class KeyStore(Protocol):
    def load(self) -> Optional[dict]: ...
    def save(self, data: dict) -> None: ...


class KeychainKeyStore:
    """The OS keychain entry ``Flowpad.ai.device_key`` / ``<instance>`` — stored the way the vault's own key is: the
    signed, ACL-restricted slot when the vendored flow-rs binary is enabled, else ``keyring`` directly."""

    SERVICE = "Flowpad.ai.device_key"

    def _account(self) -> tuple[bool, str]:
        from flow_sdk.flow_rs_binary import FLOW_RS_ACCOUNT_SUFFIX, vendored_flow_rs_enabled  # noqa: PLC0415
        from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

        name = get_instance_settings().instance_name or "prod"
        restricted = vendored_flow_rs_enabled()
        return restricted, f"{name}{FLOW_RS_ACCOUNT_SUFFIX}" if restricted else name

    def load(self) -> Optional[dict]:
        restricted, account = self._account()
        if restricted:
            from flow_sdk.flow_rs_binary import flow_rs_get_restricted  # noqa: PLC0415

            raw = flow_rs_get_restricted(self.SERVICE, account)
        else:
            import keyring  # noqa: PLC0415

            raw = keyring.get_password(self.SERVICE, account)
        return json.loads(raw) if raw else None

    def save(self, data: dict) -> None:
        restricted, account = self._account()
        if restricted:
            from flow_sdk.flow_rs_binary import flow_rs_set_restricted  # noqa: PLC0415

            flow_rs_set_restricted(self.SERVICE, account, json.dumps(data))
        else:
            import keyring  # noqa: PLC0415

            keyring.set_password(self.SERVICE, account, json.dumps(data))


_key_store: KeyStore = KeychainKeyStore()


def set_key_store(store: KeyStore) -> KeyStore:
    """Swap the keychain (tests). Answers the previous store, to restore."""
    global _key_store
    previous, _key_store = _key_store, store
    return previous


def _new_device_id() -> str:
    """This install's id plus a fresh suffix — a new device each time the keys start over."""
    import secrets  # noqa: PLC0415

    from flow_sdk.instance_settings.runtime import instance_uid  # noqa: PLC0415

    return f"{instance_uid()}.{secrets.token_hex(4)}"


def device_id() -> str:
    """The device these keys belong to (``DeviceKeyring.device_id``); before any keys exist, the one they will get."""
    stored = _key_store.load()
    return str((stored or {}).get("device_id") or "") or load_keyring()[0].device_id


def _user_id() -> str:
    from flow_sdk.cli.app_config import get_user  # noqa: PLC0415

    uid = str((get_user() or {}).get("id") or "")
    if not uid:
        raise SealedError("signed_out", "sign in to Flowpad to share or receive values securely")
    return uid


def receiving_enabled() -> bool:
    from flow_sdk.preferences import secure_receiving_enabled  # noqa: PLC0415

    return secure_receiving_enabled()


def _state_dir() -> Path:
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    folder = Path(get_instance_settings().instance_dir) / "sealed"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def _read_json(name: str) -> dict:
    from flow_sdk.instances.atomic import read_json  # noqa: PLC0415

    return read_json(_state_dir() / name)


def _write_json(name: str, data: dict) -> None:
    from flow_sdk.instances.atomic import write_json_atomic  # noqa: PLC0415

    write_json_atomic(_state_dir() / name, data)


def load_keyring(*, now: Optional[datetime] = None, rotate: bool = False) -> tuple[DeviceKeyring, Optional[DeviceKeyPair]]:
    """This install's keyring — created on first use, rotated when due (or when ``rotate``), saved only when it
    changed. Answers ``(keyring, previous)``: ``previous`` is the generation just rotated away from (it countersigns
    the new advert), else None."""
    now = now or _now()
    stored = _key_store.load()
    ring = DeviceKeyring.load(stored) if stored else DeviceKeyring(DeviceKeyPair.generate(now), device_id=_new_device_id())
    before = ring.dump() if stored else None  # before ANY change below, so each one is saved
    if not ring.device_id:  # a keyring written before device ids lived beside the keys
        ring.device_id = _new_device_id()
    ring.prune(now)
    previous = None
    if rotate or datetime.fromisoformat(ring.current.created_at) + ROTATE_AFTER <= now:
        previous = ring.rotate(now)
    if ring.dump() != before:
        _key_store.save(ring.dump())
    return ring, previous


def current_advert(ring: DeviceKeyring, previous: Optional[DeviceKeyPair] = None) -> DeviceKeyAdvertSpec:
    return make_advert(
        ring.current, user_id=_user_id(), device_id=ring.device_id, device_name=socket.gethostname(), previous=previous
    )


async def publish_device_key(*, rotate: bool = False) -> Optional[DeviceKeyAdvertSpec]:
    """Publish (or rotate) this install's advert on the hub; withdraw it when secure receiving is off. Asks the hub
    only when something changed: the key it last published is recorded in ``published.json``."""
    HubProxy, Types = _hub()
    if not receiving_enabled():
        await withdraw_device_key()
        return None
    ring, previous = load_keyring(rotate=rotate)
    published = _read_json("published.json")
    if previous is None and published == {**published, "key_id": ring.current.key_id, "user_id": _user_id(),
                                           "device_id": ring.device_id}:
        return None  # the hub already holds this key, for this device and user
    if published.get("device_id") and published["device_id"] != ring.device_id:
        await withdraw_device_key()  # the keys started over: the old device's advert names a key nobody holds
    advert = current_advert(ring, previous)
    await HubProxy.call("PUT", Types.USER, _user_id(), "device_key", payload={"advert": advert.model_dump(mode="json")})
    _write_json("published.json", {"key_id": advert.key_id, "user_id": advert.user_id, "device_id": advert.device_id,
                                   "at": _now().isoformat()})  # fmt: skip
    return advert


async def withdraw_device_key() -> None:
    """Remove EVERY advert this install published (its current device and any it started over from), so nobody seals
    to a key this install no longer holds. Asks the hub, not the local record: an advert left by an older keyring is
    known only there."""
    from flow_sdk.instance_settings.runtime import instance_uid  # noqa: PLC0415

    HubProxy, Types = _hub()
    mine = await HubProxy.try_call("GET", Types.USER, _user_id(), "device_key") or []
    install = instance_uid()
    for advert in mine:
        did = str((advert or {}).get("device_id") or "")
        if did == install or did.startswith(f"{install}."):
            await HubProxy.try_call("DELETE", Types.USER, _user_id(), "device_key", params={"device_id": did})
    _write_json("published.json", {})


def key_info() -> dict:
    """The expert view: this device's key id and when it was last published — never a key."""
    stored = _key_store.load()
    info: dict[str, Any] = {"receiving": receiving_enabled(), "device_id": (stored or {}).get("device_id"), "key_id": None,
                            "created_at": None, "retired": 0, "published": _read_json("published.json") or None}
    if stored:
        ring = DeviceKeyring.load(stored)
        info.update(key_id=ring.current.key_id, created_at=ring.current.created_at, retired=len(ring.retired))
    return info


# ── members' keys (only through the conversation's members action) ──────────


async def member_keys(conversation_id: str) -> dict[str, list[DeviceKeyAdvertSpec]]:
    """``{user_id: [trusted advert]}`` for the conversation's members. Each advert is checked against what this
    install pinned for that device: first use pins it, a rotation is followed only through its signature chain,
    anything else is dropped (the member then shows as unable to receive)."""
    HubProxy, Types = _hub()
    rows = await HubProxy.call("GET", Types.CONVERSATION, conversation_id, "list_members", DEVICE_KEYS)
    pins = _read_json("pins.json")
    out: dict[str, list[DeviceKeyAdvertSpec]] = {}
    changed = False
    for row in rows or []:
        uid = str((row or {}).get("user_id") or "")
        trusted: list[DeviceKeyAdvertSpec] = []
        for raw in (row or {}).get("devices") or []:
            try:
                advert = DeviceKeyAdvertSpec.model_validate(raw)
                if advert.user_id != uid:
                    continue
                pin_raw = (pins.get(uid) or {}).get(advert.device_id)
                pinned = DeviceKeyAdvertSpec.model_validate(pin_raw) if pin_raw else None
                accepted = accept_advert(pinned, advert)
            except (SealedError, ValueError) as e:
                logger.warning("[sealed] dropped a device key of %s: %s", uid, getattr(e, "code", type(e).__name__))
                continue
            if pinned is None or pinned.sign_pub != accepted.sign_pub:
                pins.setdefault(uid, {})[advert.device_id] = accepted.model_dump(mode="json")
                changed = True
            trusted.append(accepted)
        out[uid] = trusted
    if changed:
        _write_json("pins.json", pins)
    return out


async def receivers(conversation_id: str) -> dict[str, str]:
    """``{user_id: ok | no_key}`` — whether each member can receive values here (the recipient chips)."""
    keys = await member_keys(conversation_id)
    me = _user_id()
    return {uid: ("ok" if devices else "no_key") for uid, devices in keys.items() if uid != me}


# ── hub messages ────────────────────────────────────────────────────────────


async def _hub_messages(conversation_id: str) -> list[dict]:
    HubProxy, Types = _hub()
    rows = await HubProxy.call("GET", Types.FLOW_MESSAGE, scope=[("conversation", conversation_id)])
    return [m for m in rows or [] if isinstance(m, dict)]


async def _post(conversation_id: str, kind: str, metadata: dict, *, text: str = "", reply_to: Optional[str] = None) -> dict:
    HubProxy, Types = _hub()
    payload = {"text": text, "kind": kind, "metadata": metadata, **({"reply_to_id": reply_to} if reply_to else {})}
    return await HubProxy.call("POST", Types.CONVERSATION, conversation_id, "add_message", payload=payload)


async def _note(conversation_id: str, text: str, root: Optional[str]) -> None:
    """The quiet, automatic line of a "get it" exchange — a reply in the share's thread, sent through the one local
    message path (``handle_add_message``): it threads it, keeps this install's row and pushes it to the hub. A
    conversation not known locally gets it on the hub directly."""
    try:
        from flow_sdk.app.actions.notification_action import handle_add_message  # noqa: PLC0415
        from flow_sdk.builtin.user import User  # noqa: PLC0415

        local_user = await User.get_local()
        body = {"conversation_id": conversation_id, "message": text, "kind": NOTE_KIND,
                **({"reply_to_id": root} if root else {})}  # fmt: skip
        sent = await handle_add_message(body, local_user.typeid if local_user else None)
        if str(getattr(sent, "status", "")).lower() == "success":
            return
    except Exception:  # noqa: BLE001 — fall back to the hub
        logger.debug("[sealed] note not sent locally", exc_info=True)
    await _post(conversation_id, NOTE_KIND, {"automatic": True}, text=text, reply_to=root)


def _my_name() -> str:
    from flow_sdk.cli.app_config import get_user  # noqa: PLC0415

    user = get_user() or {}
    return str(user.get("name") or user.get("email") or "A member")


async def _remove(conversation_id: str, message_id: str) -> None:
    HubProxy, Types = _hub()
    await HubProxy.try_call("POST", Types.CONVERSATION, conversation_id, "remove_message",
                            payload={"flow_message_id": message_id})  # fmt: skip


def _envelope(msg: dict) -> Optional[SealedValueSpec]:
    if msg.get("kind") != SEALED_KIND:
        return None
    raw = (msg.get("metadata") if isinstance(msg.get("metadata"), dict) else {}).get(SEALED_KIND)
    try:
        return SealedValueSpec.model_validate(raw) if raw else None
    except ValueError:
        return None


def _envelopes(messages: list[dict]):
    """``(message, envelope)`` for every sealed value among ``messages``."""
    for m in messages:
        if (env := _envelope(m)) is not None:
            yield m, env


def _acks(messages: list[dict]) -> dict[str, dict[str, str]]:
    """``{transfer_id: {user_id: filled|declined}}`` from the ack messages (hub-stamped senders)."""
    out: dict[str, dict[str, str]] = {}
    for m in messages:
        if m.get("kind") != ACK_KIND:
            continue
        meta = m.get("metadata") or {}
        tid, outcome = str(meta.get("transfer_id") or ""), str(meta.get("outcome") or "")
        if tid and outcome in (FILLED, DECLINED) and m.get("sender_id"):
            out.setdefault(tid, {})[str(m["sender_id"])] = outcome
    return out


@dataclass
class _Snapshot:
    """One read of a conversation's secured transfers: its hub messages, their acks and the members' trusted keys —
    fetched once per request, never per message. A conversation with no sealed value asks for no keys."""

    conversation_id: str
    messages: list[dict]
    acks: dict[str, dict[str, str]]
    keys: dict[str, list[DeviceKeyAdvertSpec]]

    @classmethod
    async def read(cls, conversation_id: str) -> "_Snapshot":
        messages = await _hub_messages(conversation_id)
        has_sealed = any(m.get("kind") == SEALED_KIND for m in messages)
        keys = await member_keys(conversation_id) if has_sealed else {}
        return cls(conversation_id, messages, _acks(messages), keys)

    def of_kind(self, kind: str) -> list[dict]:
        return [m for m in self.messages if m.get("kind") == kind]

    def find(self, message_id: str) -> tuple[dict, SealedValueSpec]:
        for m, env in _envelopes(self.messages):
            if str(m.get("id")) == message_id:
                return m, env
        raise SealedError("gone", "the shared values are no longer there — ask the sender to share again")

    def sender_advert(self, message: dict, env: SealedValueSpec) -> DeviceKeyAdvertSpec:
        sender = str(message.get("sender_id") or "")
        advert = next((a for a in self.keys.get(sender, []) if a.device_id == env.sender_device_id), None)
        if advert is None:
            raise SealedError("unknown_sender", "the sender's key is not known here")
        return advert


# ── send ────────────────────────────────────────────────────────────────────


async def seal_credential(credential_typeid: str, conversation_id: str, recipient_user_ids: list[str]) -> dict:
    """Seal ``credential_typeid``'s values on this computer for the recipients' devices and post the envelope.

    Answers names only: ``{transfer_id, sealed_for, cannot_receive, variables}``. A recipient with no trusted key is
    in ``cannot_receive`` (they get the spec, not the values); nobody able to receive → ``sealed_for`` empty and
    nothing posted.
    """
    from flow_sdk.builtin.credential_resolver import resolve_project_secrets  # noqa: PLC0415
    from flow_sdk.builtin.credential_service import get_credential  # noqa: PLC0415
    from flow_sdk.builtin.credential_store import Placement, scope_of  # noqa: PLC0415

    spec, values = await _credential_values(credential_typeid)
    me = _user_id()
    keys = await member_keys(conversation_id)
    # No list: every other member of the conversation (a share into a new conversation knows emails, not ids).
    wanted = [u for u in dict.fromkeys(recipient_user_ids or list(keys)) if u and u != me]
    sealed_for = [u for u in wanted if keys.get(u)]
    later = [u for u in wanted if not keys.get(u)]
    transfer_id = await _seal_and_post(conversation_id, spec, values, keys, sealed_for) if sealed_for else None
    if later:  # no key yet: a promise they redeem after installing — no warning to the sender
        await _promise(conversation_id, credential_typeid, later)
    return {"transfer_id": transfer_id, "sealed_for": sealed_for, "later": later, "cannot_receive": [],
            "variables": sorted(values)}


async def _credential_values(credential_typeid: str):
    from flow_sdk.builtin.credential_resolver import resolve_project_secrets  # noqa: PLC0415
    from flow_sdk.builtin.credential_service import get_credential  # noqa: PLC0415
    from flow_sdk.builtin.credential_store import Placement, scope_of  # noqa: PLC0415

    spec = await get_credential(credential_typeid)
    if spec is None:
        raise SealedError("no_credential", "credential not found")
    _, project = await scope_of(spec)
    values = await resolve_project_secrets(project, only=list(spec.stored_var_names()), placement=await Placement.of(None))
    if not values:
        raise SealedError("no_values", f"{spec.title or spec.name} has no values on this computer to share")
    return spec, values


async def _seal_and_post(conversation_id: str, spec, values, keys, users: list[str], *, answers: str = "") -> str:
    ring, previous = load_keyring()
    if previous is not None:  # a due rotation: publish it before sealing with the new key
        await publish_device_key()
    env = seal(
        ring.current, sender_user_id=_user_id(), sender_device_id=ring.device_id, conversation_id=conversation_id,
        recipients=[a for u in users for a in keys[u]], credential_name=spec.name,
        credential_title=spec.title or spec.name, values=values,
    )  # fmt: skip
    await _post(conversation_id, SEALED_KIND, {SEALED_KIND: env.model_dump(mode="json"), **({"answers": answers} if answers else {})})
    _record_sent(env.transfer_id, conversation_id, users, env.expires_at)
    return env.transfer_id


def _record_sent(transfer_id: str, conversation_id: str, users: list[str], expires_at: str) -> None:
    """The sender's record of a transfer (users, never values) — its card outlives the envelope deleted once everyone
    answered. Synchronous: no await between the read and the write, so it needs no lock."""
    sent = _read_json("sent.json")
    sent[transfer_id] = {"conversation_id": conversation_id, "recipients": users, "expires_at": expires_at}
    _write_json("sent.json", sent)


async def _promise(conversation_id: str, credential_typeid: str, users: list[str]) -> str:
    """A promise to members with no key yet: a hub-only ``sealed_pending`` (names only the users, never the
    credential), and this install's own record of what to seal when they ask (``pending.json``)."""
    from flow_sdk.api.api_types.identifier import mint_uuid  # noqa: PLC0415
    from flow_sdk.secrets.sealed import SEALED_TTL  # noqa: PLC0415

    me, ref = _user_id(), credential_typeid.split("-", 1)[-1]
    shares = [m for m in await _hub_messages(conversation_id) if str(m.get("sender_id")) == me
              and any(ref in str((a or {}).get("data") or "") for a in m.get("attachment") or [])]  # fmt: skip
    root = str(shares[-1]["id"]) if shares else None
    transfer_id, expires = mint_uuid(), (_now() + SEALED_TTL).isoformat()
    msg = await _post(conversation_id, PENDING_KIND,
                      {"transfer_id": transfer_id, "recipients": users, "expires_at": expires, "root": root})  # fmt: skip
    async with _lock():
        pending = _read_json("pending.json")
        pending[transfer_id] = {"conversation_id": conversation_id, "credential_typeid": credential_typeid,
                                "recipients": users, "answered": [], "root": root, "expires_at": expires,
                                "message_id": str((msg or {}).get("id") or "")}  # fmt: skip
        _write_json("pending.json", pending)
    return transfer_id


_pending_locks: dict = {}


def _lock():
    """One writer of ``pending.json`` at a time (per event loop): a promise recorded while an answer pass runs must
    not be lost. Not re-entrant — code holding it never takes it again."""
    import asyncio  # noqa: PLC0415

    loop = asyncio.get_running_loop()
    return _pending_locks.setdefault(id(loop), asyncio.Lock())


async def answer_requests(conversation_id: str) -> list[str]:
    """Answer every "get it" request this install owes in the conversation — automatically: the sender approved the
    share. For each request from a member a pending promise names: read their key through the members action, seal
    this computer's values for their devices, post them (``answers`` the promise) and a quiet thread note. A promise
    everyone answered (or that expired) is withdrawn. Answers the user ids served.

    One at a time: a request and its note arrive as two messages, each a trigger — two concurrent passes would both
    see the request unanswered and seal twice."""
    async with _lock():
        return await _answer_requests(conversation_id)


async def _answer_requests(conversation_id: str) -> list[str]:
    pending = {t: p for t, p in _read_json("pending.json").items() if p.get("conversation_id") == conversation_id}
    if not pending:
        return []
    messages = await _hub_messages(conversation_id)
    keys: Optional[dict] = None
    served: list[str] = []
    for m in messages:
        tid = str((m.get("metadata") or {}).get("transfer_id") or "")
        uid = str(m.get("sender_id") or "")
        p = pending.get(tid)
        if m.get("kind") != REQUEST_KIND or p is None or uid not in p["recipients"] or uid in p["answered"]:
            continue
        if datetime.fromisoformat(p["expires_at"]) <= _now():
            continue
        keys = keys if keys is not None else await member_keys(conversation_id)
        if not keys.get(uid):
            continue  # their key is not listed (yet) through the members action: the next arrival retries
        spec, values = await _credential_values(p["credential_typeid"])
        await _seal_and_post(conversation_id, spec, values, keys, [uid], answers=tid)
        await _note(conversation_id, f"Secured transfer key sent to {m.get('sender_name') or 'them'}", p.get("root"))
        p["answered"].append(uid)
        served.append(uid)
    done = [tid for tid, p in pending.items()
            if set(p["recipients"]) <= set(p["answered"]) or datetime.fromisoformat(p["expires_at"]) <= _now()]  # fmt: skip
    for tid in done:
        if pending[tid].get("message_id"):
            await _remove(conversation_id, pending[tid]["message_id"])
    current = _read_json("pending.json")  # re-read: only this conversation's entries change here
    for tid, p in pending.items():
        if tid in done:
            current.pop(tid, None)
        elif tid in current:
            current[tid] = p
    _write_json("pending.json", current)
    return served


async def answer_pending() -> None:
    """The catch-up after sign-in: answer what was requested while this install was offline."""
    for conversation_id in sorted({p.get("conversation_id") for p in _read_json("pending.json").values()} - {None}):
        try:
            await answer_requests(conversation_id)
        except Exception:  # noqa: BLE001 — one conversation's failure never blocks the others
            logger.info("[sealed] catch-up failed for %s", conversation_id, exc_info=True)


async def get_secret(conversation_id: str, transfer_id: str) -> dict:
    """The recipient's one click: turn on receiving here (publish this install's key), ask the sender's Flowpad, and
    leave a quiet note in the share's thread. The values arrive by themselves when the sender's Flowpad answers."""
    from flow_sdk.preferences import PREF_SECURE_RECEIVING, write_instance_pref  # noqa: PLC0415

    promise = next((m for m in await _hub_messages(conversation_id) if m.get("kind") == PENDING_KIND
                    and str((m.get("metadata") or {}).get("transfer_id")) == transfer_id), None)  # fmt: skip
    meta = (promise or {}).get("metadata") or {}
    if promise is None or _user_id() not in (meta.get("recipients") or []):
        raise SealedError("gone", "these values are no longer waiting for you — ask the sender to share again")
    if datetime.fromisoformat(meta["expires_at"]) <= _now():
        raise SealedError("expired", "these values expired — ask the sender to share again")
    if not receiving_enabled():
        write_instance_pref(PREF_SECURE_RECEIVING, True)
    await publish_device_key()
    await _post(conversation_id, REQUEST_KIND, {"transfer_id": transfer_id})
    await _note(conversation_id, f"{_my_name()} shared public key for secured transfer", meta.get("root"))
    return {"requested": transfer_id}


async def _sent(snap: _Snapshot) -> list[dict]:
    """The sender's view: per transfer it sent here, who filled / declined / is still pending — from its own record
    (``sent.json``) and the acks, so the card stays after the envelope is gone. The envelope is deleted from the hub
    once every recipient answered (or it expired)."""
    me = _user_id()
    envelopes = {env.transfer_id: m for m, env in _envelopes(snap.messages) if str(m.get("sender_id")) == me}
    out, done = [], []
    for tid, rec in _read_json("sent.json").items():
        if rec.get("conversation_id") != snap.conversation_id:
            continue
        answered = snap.acks.get(tid, {})
        state = {uid: answered.get(uid, "pending") for uid in rec.get("recipients") or []}
        expired = datetime.fromisoformat(rec["expires_at"]) <= _now() and "pending" in state.values()
        message = envelopes.get(tid)
        if message is not None and (expired or "pending" not in state.values()):
            done.append(str(message["id"]))
        out.append({"message_id": (message or {}).get("id") or tid, "transfer_id": tid, "expires_at": rec["expires_at"],
                    "recipients": state, "expired": expired})  # fmt: skip
    for m in snap.of_kind(PENDING_KIND):  # promised to members with no key yet: waiting, calmly
        meta = m.get("metadata") or {}
        if str(m.get("sender_id")) == me:
            out.append({"message_id": m["id"], "transfer_id": meta.get("transfer_id"), "expires_at": meta.get("expires_at"),
                        "recipients": {u: "pending" for u in meta.get("recipients") or []}, "expired": False})  # fmt: skip
    for message_id in done:
        await _remove(snap.conversation_id, message_id)
    return out


def _seen() -> set[str]:
    return set(_read_json("seen.json").get("transfers") or [])


async def _incoming(snap: _Snapshot) -> list[dict]:
    """The receiver's cards: every sealed value here addressed to this device — names only, never a value.
    ``state``: ``pending`` | ``filled`` | ``declined`` | an error code (``expired``, ``bad_signature``, …)."""
    me, mine = _user_id(), device_id()
    stored = _key_store.load()
    ring = DeviceKeyring.load(stored) if stored else None
    seen = _seen()
    out = []
    for m, env in _envelopes(snap.messages):
        if not any(r.device_id == mine for r in env.recipients):
            continue
        card = {"message_id": m["id"], "transfer_id": env.transfer_id, "sender_id": m.get("sender_id"),
                "sender_name": m.get("sender_name"), "expires_at": env.expires_at}  # fmt: skip
        answered = snap.acks.get(env.transfer_id, {}).get(me)
        if answered:
            out.append({**card, "state": answered})
            continue
        try:
            if ring is None:
                raise SealedError("key_gone", "this device has no keys")
            payload = open_sealed(env, ring, device_id=mine, sender_advert=snap.sender_advert(m, env),
                                  sender_user_id=str(m.get("sender_id") or ""), conversation_id=snap.conversation_id,
                                  seen=seen)  # fmt: skip
            card.update(state="pending", credential_name=payload.credential_name,
                        credential_title=payload.credential_title, variables=sorted(payload.values))  # fmt: skip
        except SealedError as e:
            card.update(state=e.code, error=str(e))
        out.append(card)
    out.extend(_promise_cards(snap, me))
    return out


def _promise_cards(snap: _Snapshot, me: str) -> list[dict]:
    """Promises naming me that no sealed value answered yet: ``get`` (Get the secret) or ``requested`` (waiting)."""
    answered = {str((m.get("metadata") or {}).get("answers") or "") for m in snap.of_kind(SEALED_KIND)}
    asked = {str((m.get("metadata") or {}).get("transfer_id") or ""): m for m in snap.of_kind(REQUEST_KIND)
             if str(m.get("sender_id")) == me}  # fmt: skip
    cards = []
    for m in snap.of_kind(PENDING_KIND):
        meta = m.get("metadata") or {}
        tid = str(meta.get("transfer_id") or "")
        if me not in (meta.get("recipients") or []) or tid in answered:
            continue
        expired = datetime.fromisoformat(str(meta.get("expires_at"))) <= _now()
        request = asked.get(tid)
        cards.append({"message_id": m["id"], "transfer_id": tid, "sender_id": m.get("sender_id"),
                      "sender_name": m.get("sender_name"), "expires_at": meta.get("expires_at"),
                      "state": "expired" if expired else ("requested" if request else "get"),
                      "requested_at": (request or {}).get("created_date")})  # fmt: skip
    return cards


async def state(conversation_id: str) -> dict:
    """Both views from ONE read of the hub: ``{incoming, sent}`` — what the conversation's card shows."""
    snap = await _Snapshot.read(conversation_id)
    sent_here = any(r.get("conversation_id") == conversation_id for r in _read_json("sent.json").values())
    if not snap.keys and not snap.of_kind(PENDING_KIND) and not snap.of_kind(ACK_KIND) and not sent_here:
        return {"incoming": [], "sent": []}
    return {"incoming": await _incoming(snap), "sent": await _sent(snap)}


async def incoming(conversation_id: str) -> list[dict]:
    return (await state(conversation_id))["incoming"]


async def sent_status(conversation_id: str) -> list[dict]:
    return (await state(conversation_id))["sent"]


# ── receive ─────────────────────────────────────────────────────────────────


async def _target_credential(name: str, project_id: Optional[str]):
    """The receiver's OWN declaration of the credential — values fill only what it declares."""
    from flow_sdk.builtin.credential import Credential  # noqa: PLC0415
    from flow_sdk.builtin.credential_service import get_project  # noqa: PLC0415

    project = await get_project(project_id) if project_id else None
    if project is not None:
        try:
            return await Credential.get(name, project)
        except Exception:  # noqa: BLE001 — fall through to the other installs of that name
            pass
    rows = [r for r in await Credential.get_all({"match": {"name": name}}) or [] if not getattr(r, "is_template", False)]
    if len(rows) == 1:
        return rows[0]
    raise SealedError(
        "not_installed" if not rows else "ambiguous",
        f"add the shared credential {name!r} first" if not rows else f"several credentials are named {name!r}: open one",
    )


async def fill(conversation_id: str, message_id: str, *, project_id: Optional[str] = None) -> dict:
    """Open the sealed value and write it into this computer's own credential, then tell the sender (no value)."""
    from flow_sdk.builtin.credential_service import _reverify_waiting_sources, set_credential_values  # noqa: PLC0415

    snap = await _Snapshot.read(conversation_id)
    message, env = snap.find(message_id)
    stored = _key_store.load()
    if stored is None:
        raise SealedError("key_gone", "this device has no keys")
    payload = open_sealed(env, DeviceKeyring.load(stored), device_id=device_id(),
                          sender_advert=snap.sender_advert(message, env), sender_user_id=str(message.get("sender_id") or ""),
                          conversation_id=conversation_id, seen=_seen())  # fmt: skip
    spec = await _target_credential(payload.credential_name, project_id)
    extra = sorted(set(payload.values) - set(spec.vars or {}))
    if extra:
        raise SealedError("undeclared", f"{', '.join(extra)} is not a variable of {spec.name}; nothing was written")
    await set_credential_values(str(spec.typeid), {k: v.get_secret_value() for k, v in payload.values.items()})
    await _answer(conversation_id, env.transfer_id, FILLED)
    try:
        await _reverify_waiting_sources(spec.name, getattr(spec, "project", None))
    except Exception:  # noqa: BLE001 — the values are in; a source re-check is best effort
        logger.debug("[sealed] reverify after fill failed", exc_info=True)
    return {"filled": sorted(payload.values), "credential": str(spec.typeid), "transfer_id": env.transfer_id}


async def decline(conversation_id: str, message_id: str) -> dict:
    _, env = (await _Snapshot.read(conversation_id)).find(message_id)
    await _answer(conversation_id, env.transfer_id, DECLINED)
    return {"declined": env.transfer_id}


async def _answer(conversation_id: str, transfer_id: str, outcome: str) -> None:
    """Remember the transfer as opened (no replay), then tell the sender — the outcome, never a value."""
    _write_json("seen.json", {"transfers": sorted(_seen() | {transfer_id})})
    await _post(conversation_id, ACK_KIND, {"transfer_id": transfer_id, "outcome": outcome})


__all__ = [
    "KeychainKeyStore",
    "decline",
    "answer_pending",
    "answer_requests",
    "fill",
    "get_secret",
    "incoming",
    "key_info",
    "member_keys",
    "on_sealed_arrival",
    "publish_device_key",
    "receivers",
    "seal_credential",
    "sent_status",
    "set_key_store",
    "state",
    "withdraw_device_key",
]
