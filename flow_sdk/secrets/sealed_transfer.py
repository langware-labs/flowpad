"""Secured transfer — a credential's values from one member to another, end to end (``docs/secret_share.md``).

This install's keys live in the OS keychain (never the hub, never the consent-gated vault). Its public half is
published to the hub (``<user>/device_key``); other members' keys are read ONLY through a members action of the
conversation (``conversation/<id>/list_members/device_keys``) and pinned on first use, following a rotation only
through its signed chain (``sealed.accept_advert``).

On the hub a transfer is two kinds of FlowMessage that never materialize locally (:func:`is_hub_only`):
``sealed_value`` — the envelope in ``metadata`` — and ``sealed_ack`` — "filled" / "declined", no value. The
sender deletes the envelope once every recipient answered. Values are read from this computer's store, sealed in
memory, and written on the receiver through the credential writer with ``literal=True``; nothing here logs,
returns or stores a value.
"""

from __future__ import annotations

import json
import logging
import socket
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional, Protocol

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

SEALED_KIND = "sealed_value"
ACK_KIND = "sealed_ack"
HUB_ONLY_KINDS = frozenset({SEALED_KIND, ACK_KIND})
#: A device rotates its keys this often; the retired keys stay until what was sealed to them expired.
ROTATE_AFTER = timedelta(days=30)
DEVICE_KEYS = "device_keys"
FILLED, DECLINED = "filled", "declined"


def is_hub_only(payload: Any) -> bool:
    """A sealed value or its ack: relayed by the hub, never a local chat row."""
    return isinstance(payload, dict) and str(payload.get("kind") or "") in HUB_ONLY_KINDS


async def on_sealed_arrival(conversation_id: str) -> None:
    """A sealed value or ack arrived live: refresh the conversation so its card re-reads the hub."""
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
    def clear(self) -> None: ...


class KeychainKeyStore:
    """The OS keychain entry ``Flowpad.ai.device_key`` / ``<instance>`` — the same mechanism as the vault's key."""

    SERVICE = "Flowpad.ai.device_key"

    def _user(self) -> str:
        from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

        return get_instance_settings().instance_name or "prod"

    def load(self) -> Optional[dict]:
        import keyring  # noqa: PLC0415

        raw = keyring.get_password(self.SERVICE, self._user())
        return json.loads(raw) if raw else None

    def save(self, data: dict) -> None:
        import keyring  # noqa: PLC0415

        keyring.set_password(self.SERVICE, self._user(), json.dumps(data))

    def clear(self) -> None:
        import keyring  # noqa: PLC0415

        try:
            keyring.delete_password(self.SERVICE, self._user())
        except Exception:  # noqa: BLE001 — nothing stored is the cleared state
            pass


_key_store: KeyStore = KeychainKeyStore()


def set_key_store(store: KeyStore) -> KeyStore:
    """Swap the keychain (tests). Answers the previous store, to restore."""
    global _key_store
    previous, _key_store = _key_store, store
    return previous


def device_id() -> str:
    from flow_sdk.instance_settings.runtime import instance_uid  # noqa: PLC0415

    return instance_uid()


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
    path = _state_dir() / name
    try:
        return json.loads(path.read_text()) if path.is_file() else {}
    except (OSError, ValueError):
        return {}


def _write_json(name: str, data: dict) -> None:
    path = _state_dir() / name
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, sort_keys=True))
    tmp.replace(path)


def load_keyring(*, now: Optional[datetime] = None) -> tuple[DeviceKeyring, Optional[DeviceKeyPair]]:
    """This install's keyring, created on first use and rotated when due. Answers ``(keyring, previous)`` —
    ``previous`` is the generation just rotated away from (it countersigns the new advert), else None."""
    now = now or datetime.now(timezone.utc)
    stored = _key_store.load()
    previous = None
    if stored is None:
        ring = DeviceKeyring(DeviceKeyPair.generate(now))
    else:
        ring = DeviceKeyring.load(stored)
        ring.prune(now)
        if datetime.fromisoformat(ring.current.created_at) + ROTATE_AFTER <= now:
            previous = ring.rotate(now)
    _key_store.save(ring.dump())
    return ring, previous


def rotate_now() -> tuple[DeviceKeyring, DeviceKeyPair]:
    """Rotate on demand (settings' expert view): a new generation, countersigned by the current one."""
    ring, _ = load_keyring()
    previous = ring.rotate()
    _key_store.save(ring.dump())
    return ring, previous


def current_advert(ring: DeviceKeyring, previous: Optional[DeviceKeyPair] = None) -> DeviceKeyAdvertSpec:
    return make_advert(
        ring.current, user_id=_user_id(), device_id=device_id(), device_name=socket.gethostname(), previous=previous
    )


async def publish_device_key(*, rotate: bool = False) -> Optional[DeviceKeyAdvertSpec]:
    """Publish (or rotate) this install's advert on the hub; withdraw it when secure receiving is off.
    Idempotent — the hub replaces the advert in place."""
    from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415
    from flow_sdk.db.drivers.db_base_record import BuiltinEntityType  # noqa: PLC0415

    if not receiving_enabled():
        await withdraw_device_key()
        return None
    ring, previous = rotate_now() if rotate else load_keyring()
    advert = current_advert(ring, previous)
    await HubProxy.call(
        "PUT", BuiltinEntityType.USER, _user_id(), "device_key", payload={"advert": advert.model_dump(mode="json")}
    )
    _write_json("published.json", {"key_id": advert.key_id, "at": datetime.now(timezone.utc).isoformat()})
    return advert


async def withdraw_device_key() -> None:
    from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415
    from flow_sdk.db.drivers.db_base_record import BuiltinEntityType  # noqa: PLC0415

    await HubProxy.try_call(
        "DELETE", BuiltinEntityType.USER, _user_id(), "device_key", params={"device_id": device_id()}
    )


def key_info() -> dict:
    """The expert view: this device's key id and when it was last published — never a key."""
    stored = _key_store.load()
    ring = DeviceKeyring.load(stored) if stored else None
    return {
        "receiving": receiving_enabled(),
        "device_id": device_id(),
        "key_id": ring.current.key_id if ring else None,
        "created_at": ring.current.created_at if ring else None,
        "retired": len(ring.retired) if ring else 0,
        "published": _read_json("published.json") or None,
    }


# ── members' keys (only through the conversation's members action) ──────────


async def member_keys(conversation_id: str) -> dict[str, list[DeviceKeyAdvertSpec]]:
    """``{user_id: [trusted advert]}`` for the conversation's members. Each advert is checked against what this
    install pinned for that device: first use pins it, a rotation is followed only through its signature chain,
    anything else is dropped (the member then shows as unable to receive)."""
    from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415
    from flow_sdk.db.drivers.db_base_record import BuiltinEntityType  # noqa: PLC0415

    rows = await HubProxy.call("GET", BuiltinEntityType.CONVERSATION, conversation_id, "list_members", DEVICE_KEYS)
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
    from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415
    from flow_sdk.db.drivers.db_base_record import BuiltinEntityType  # noqa: PLC0415

    rows = await HubProxy.call("GET", BuiltinEntityType.FLOW_MESSAGE, scope=[("conversation", conversation_id)])
    return [m for m in rows or [] if isinstance(m, dict)]


async def _post(conversation_id: str, kind: str, metadata: dict) -> dict:
    from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415
    from flow_sdk.db.drivers.db_base_record import BuiltinEntityType  # noqa: PLC0415

    return await HubProxy.call(
        "POST", BuiltinEntityType.CONVERSATION, conversation_id, "add_message",
        payload={"text": "", "kind": kind, "metadata": metadata},
    )  # fmt: skip


async def _remove(conversation_id: str, message_id: str) -> None:
    from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415
    from flow_sdk.db.drivers.db_base_record import BuiltinEntityType  # noqa: PLC0415

    await HubProxy.try_call(
        "POST", BuiltinEntityType.CONVERSATION, conversation_id, "remove_message", payload={"flow_message_id": message_id}
    )


def _envelope(msg: dict) -> Optional[SealedValueSpec]:
    raw = ((msg.get("metadata") or {}) if isinstance(msg.get("metadata"), dict) else {}).get(SEALED_KIND)
    try:
        return SealedValueSpec.model_validate(raw) if raw else None
    except ValueError:
        return None


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

    spec = await get_credential(credential_typeid)
    if spec is None:
        raise SealedError("no_credential", "credential not found")
    names = list(spec.stored_var_names())
    _, project = await scope_of(spec)
    values = await resolve_project_secrets(project, only=names, placement=await Placement.of(None))
    if not values:
        raise SealedError("no_values", f"{spec.title or spec.name} has no values on this computer to share")

    me = _user_id()
    keys = await member_keys(conversation_id)
    # No list: every other member of the conversation (a share into a new conversation knows emails, not ids).
    wanted = [u for u in dict.fromkeys(recipient_user_ids or list(keys)) if u and u != me]
    sealed_for = [u for u in wanted if keys.get(u)]
    cannot = [u for u in wanted if not keys.get(u)]
    if not sealed_for:
        return {"transfer_id": None, "sealed_for": [], "cannot_receive": cannot, "variables": sorted(values)}

    ring, previous = load_keyring()
    if previous is not None:  # a due rotation: publish it before sealing with the new key
        await publish_device_key()
    env = seal(
        ring.current, sender_user_id=me, sender_device_id=device_id(), conversation_id=conversation_id,
        recipients=[a for u in sealed_for for a in keys[u]], credential_name=spec.name,
        credential_title=spec.title or spec.name, values=values,
    )  # fmt: skip
    await _post(conversation_id, SEALED_KIND, {SEALED_KIND: env.model_dump(mode="json")})
    return {"transfer_id": env.transfer_id, "sealed_for": sealed_for, "cannot_receive": cannot, "variables": sorted(values)}


async def sent_status(conversation_id: str) -> list[dict]:
    """The sender's view: per transfer it sent here, who filled / declined / is still pending. A transfer every
    recipient answered has its envelope deleted from the hub."""
    me = _user_id()
    messages = await _hub_messages(conversation_id)
    acks = _acks(messages)
    keys: Optional[dict] = None
    out = []
    for m in messages:
        env = _envelope(m) if m.get("kind") == SEALED_KIND and str(m.get("sender_id")) == me else None
        if env is None:
            continue
        if keys is None:
            keys = {a.device_id: uid for uid, ads in (await member_keys(conversation_id)).items() for a in ads}
        recipients = sorted({keys.get(r.device_id, "") for r in env.recipients} - {""})
        answered = acks.get(env.transfer_id, {})
        state = {uid: answered.get(uid, "pending") for uid in recipients}
        expired = datetime.fromisoformat(env.expires_at) <= datetime.now(timezone.utc)
        if recipients and all(s != "pending" for s in state.values()) or expired:
            await _remove(conversation_id, str(m["id"]))
        out.append({"message_id": m["id"], "transfer_id": env.transfer_id, "expires_at": env.expires_at,
                    "recipients": state, "expired": expired})  # fmt: skip
    return out


# ── receive ─────────────────────────────────────────────────────────────────


def _seen() -> set[str]:
    return set(_read_json("seen.json").get("transfers") or [])


def _mark_seen(transfer_id: str) -> None:
    seen = _seen() | {transfer_id}
    _write_json("seen.json", {"transfers": sorted(seen)})


async def _open(conversation_id: str, message: dict, env: SealedValueSpec):
    keys = await member_keys(conversation_id)
    sender = str(message.get("sender_id") or "")
    advert = next((a for a in keys.get(sender, []) if a.device_id == env.sender_device_id), None)
    if advert is None:
        raise SealedError("unknown_sender", "the sender's key is not known here")
    stored = _key_store.load()
    if stored is None:
        raise SealedError("key_gone", "this device has no keys")
    return open_sealed(
        env, DeviceKeyring.load(stored), device_id=device_id(), sender_advert=advert, sender_user_id=sender,
        conversation_id=conversation_id, seen=_seen(),
    )  # fmt: skip


async def incoming(conversation_id: str) -> list[dict]:
    """The receiver's cards: every sealed value here addressed to this device — names only, never a value.
    ``state``: ``pending`` | ``filled`` | ``declined`` | an error code (``expired``, ``bad_signature``, …)."""
    me, mine = _user_id(), device_id()
    messages = await _hub_messages(conversation_id)
    acks = _acks(messages)
    out = []
    for m in messages:
        env = _envelope(m) if m.get("kind") == SEALED_KIND else None
        if env is None or not any(r.device_id == mine for r in env.recipients):
            continue
        card = {"message_id": m["id"], "transfer_id": env.transfer_id, "sender_id": m.get("sender_id"),
                "sender_name": m.get("sender_name"), "expires_at": env.expires_at}  # fmt: skip
        answered = acks.get(env.transfer_id, {}).get(me)
        if answered:
            out.append({**card, "state": answered})
            continue
        try:
            payload = await _open(conversation_id, m, env)
            card.update(state="pending", credential_name=payload.credential_name,
                        credential_title=payload.credential_title, variables=sorted(payload.values))  # fmt: skip
        except SealedError as e:
            card.update(state=e.code, error=str(e))
        out.append(card)
    return out


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

    message = next((m for m in await _hub_messages(conversation_id) if str(m.get("id")) == message_id), None)
    env = _envelope(message) if message else None
    if env is None:
        raise SealedError("gone", "the shared values are no longer there — ask the sender to share again")
    payload = await _open(conversation_id, message, env)
    spec = await _target_credential(payload.credential_name, project_id)
    declared = set(spec.vars or {})
    extra = sorted(set(payload.values) - declared)
    if extra:
        raise SealedError("undeclared", f"{', '.join(extra)} is not a variable of {spec.name}; nothing was written")
    await set_credential_values(
        str(spec.typeid), {k: v.get_secret_value() for k, v in payload.values.items()}, literal=True
    )
    _mark_seen(env.transfer_id)
    await _post(conversation_id, ACK_KIND, {"transfer_id": env.transfer_id, "outcome": FILLED})
    try:
        await _reverify_waiting_sources(spec.name, getattr(spec, "project", None))
    except Exception:  # noqa: BLE001 — the values are in; a source re-check is best effort
        logger.debug("[sealed] reverify after fill failed", exc_info=True)
    return {"filled": sorted(payload.values), "credential": str(spec.typeid), "transfer_id": env.transfer_id}


async def decline(conversation_id: str, message_id: str) -> dict:
    message = next((m for m in await _hub_messages(conversation_id) if str(m.get("id")) == message_id), None)
    env = _envelope(message) if message else None
    if env is None:
        raise SealedError("gone", "the shared values are no longer there")
    _mark_seen(env.transfer_id)
    await _post(conversation_id, ACK_KIND, {"transfer_id": env.transfer_id, "outcome": DECLINED})
    return {"declined": env.transfer_id}


__all__ = [
    "ACK_KIND",
    "HUB_ONLY_KINDS",
    "SEALED_KIND",
    "KeychainKeyStore",
    "decline",
    "fill",
    "incoming",
    "is_hub_only",
    "key_info",
    "member_keys",
    "on_sealed_arrival",
    "publish_device_key",
    "receivers",
    "seal_credential",
    "sent_status",
    "set_key_store",
    "withdraw_device_key",
]
