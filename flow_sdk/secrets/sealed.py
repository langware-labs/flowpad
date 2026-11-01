"""Secured transfer — the crypto. Pure: no I/O, no hub, no store (``docs/secret_share.md``).

A device (one Flowpad install) holds an Ed25519 signing key and an X25519 sealing key. Its public half
is a :class:`DeviceKeyAdvertSpec`, self-signed; a rotation is signed by the previous signing key as well,
so a receiver that pinned the old key follows the chain instead of facing a silent swap.

A transfer is a :class:`SealedValueSpec`: one random body key encrypts the payload (credential name and
values — names stay inside), and is wrapped for each recipient device; the header is the AEAD's associated
data and the sender's signature covers the whole envelope. Opening checks, in order: the sender's signature
against the advert the caller trusts, the conversation, expiry, replay, then decrypts with the device key the
envelope names.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Iterable, Mapping, Optional

from cryptography.exceptions import InvalidSignature, InvalidTag
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from pydantic import SecretStr

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.schema.data_spec.sealed_value_spec import (
    SUITE_V1,
    DeviceKeyAdvertSpec,
    SealedPayloadSpec,
    SealedRecipientSpec,
    SealedValueSpec,
)

#: How long a sealed value can be opened. A rotated device keeps its old key at least this long.
SEALED_TTL = timedelta(days=7)
_WRAP_INFO = b"flowpad.sealed.v1.wrap|"


class SealedError(Exception):
    """A sealed value or advert that must not be trusted or cannot be opened. ``code`` says why."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.b64decode(text.encode("ascii"))


def _canon(data: Mapping) -> bytes:
    return json.dumps(data, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _raw_pub(key) -> bytes:
    return key.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)


def _raw_priv(key) -> bytes:
    return key.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption())


def key_id_of(enc_pub_b64: str) -> str:
    """Short fingerprint of a sealing key — what an envelope names to pick the key it was sealed to."""
    return hashlib.sha256(_unb64(enc_pub_b64)).hexdigest()[:16]


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(when: datetime) -> str:
    return when.astimezone(timezone.utc).isoformat()


# ── device keys ─────────────────────────────────────────────────────────────


@dataclass
class DeviceKeyPair:
    """One generation of a device's keys. Private bytes live only in this object and the OS keychain."""

    sign: Ed25519PrivateKey
    enc: X25519PrivateKey
    created_at: str

    @classmethod
    def generate(cls, now: Optional[datetime] = None) -> "DeviceKeyPair":
        return cls(Ed25519PrivateKey.generate(), X25519PrivateKey.generate(), _iso(now or _now()))

    @property
    def sign_pub(self) -> str:
        return _b64(_raw_pub(self.sign.public_key()))

    @property
    def enc_pub(self) -> str:
        return _b64(_raw_pub(self.enc.public_key()))

    @property
    def key_id(self) -> str:
        return key_id_of(self.enc_pub)

    def dump(self) -> dict:
        """For the keychain only."""
        return {"sign": _b64(_raw_priv(self.sign)), "enc": _b64(_raw_priv(self.enc)), "created_at": self.created_at}

    @classmethod
    def load(cls, data: Mapping) -> "DeviceKeyPair":
        return cls(
            Ed25519PrivateKey.from_private_bytes(_unb64(data["sign"])),
            X25519PrivateKey.from_private_bytes(_unb64(data["enc"])),
            str(data["created_at"]),
        )


@dataclass
class DeviceKeyring:
    """A device's current keys plus the ones it rotated away from, kept until what was sealed to them expires.

    ``device_id`` is minted WITH the first keys and lives beside them: an install that loses its keyring (a reset
    keychain) starts as a new device, trusted afresh — never as an unsigned key swap of its old self."""

    current: DeviceKeyPair
    retired: list[tuple[DeviceKeyPair, str]] = field(default_factory=list)  # (keys, keep_until iso)
    device_id: str = ""

    def rotate(self, now: Optional[datetime] = None) -> DeviceKeyPair:
        """A new generation; the old one is kept for :data:`SEALED_TTL` so envelopes in flight still open."""
        now = now or _now()
        previous = self.current
        self.retired.append((previous, _iso(now + SEALED_TTL)))
        self.current = DeviceKeyPair.generate(now)
        return previous

    def prune(self, now: Optional[datetime] = None) -> None:
        now = now or _now()
        self.retired = [(k, until) for k, until in self.retired if datetime.fromisoformat(until) > now]

    def by_key_id(self, key_id: str) -> Optional[DeviceKeyPair]:
        for keys in [self.current, *(k for k, _ in self.retired)]:
            if keys.key_id == key_id:
                return keys
        return None

    def dump(self) -> dict:
        return {"current": self.current.dump(), "device_id": self.device_id,
                "retired": [{"keys": k.dump(), "keep_until": u} for k, u in self.retired]}

    @classmethod
    def load(cls, data: Mapping) -> "DeviceKeyring":
        return cls(
            DeviceKeyPair.load(data["current"]),
            [(DeviceKeyPair.load(r["keys"]), str(r["keep_until"])) for r in data.get("retired") or []],
            str(data.get("device_id") or ""),
        )


def _advert_body(advert: DeviceKeyAdvertSpec) -> bytes:
    return _canon(advert.model_dump(mode="json", exclude={"sig", "prev_sig"}))


def make_advert(
    keys: DeviceKeyPair,
    *,
    user_id: str,
    device_id: str,
    device_name: str = "",
    previous: Optional[DeviceKeyPair] = None,
) -> DeviceKeyAdvertSpec:
    """This device's signed public keys. ``previous``: the generation it rotates from — it countersigns."""
    unsigned = DeviceKeyAdvertSpec(
        user_id=user_id,
        device_id=device_id,
        device_name=device_name,
        sign_pub=keys.sign_pub,
        enc_pub=keys.enc_pub,
        key_id=keys.key_id,
        created_at=keys.created_at,
        prev_sign_pub=previous.sign_pub if previous is not None else "",
    )
    body = _advert_body(unsigned)
    return unsigned.model_copy(
        update={
            "sig": _b64(keys.sign.sign(body)),
            "prev_sig": _b64(previous.sign.sign(body)) if previous is not None else "",
        }
    )


def verify_advert(advert: DeviceKeyAdvertSpec) -> None:
    """The advert is signed by its own key (and, for a rotation, by the key it names as previous)."""
    body = _advert_body(advert)
    if advert.key_id != key_id_of(advert.enc_pub):
        raise SealedError("bad_advert", "the advert's key id does not match its key")
    try:
        Ed25519PublicKey.from_public_bytes(_unb64(advert.sign_pub)).verify(_unb64(advert.sig), body)
        if advert.prev_sign_pub:
            Ed25519PublicKey.from_public_bytes(_unb64(advert.prev_sign_pub)).verify(_unb64(advert.prev_sig), body)
    except (InvalidSignature, ValueError) as e:
        raise SealedError("bad_advert", "the advert's signature does not verify") from e


def accept_advert(pinned: Optional[DeviceKeyAdvertSpec], advert: DeviceKeyAdvertSpec) -> DeviceKeyAdvertSpec:
    """Trust on first use, then follow rotations only through their signed chain.

    ``pinned``: the advert this caller already trusts for the same user's device (None the first time).
    Returns the advert to pin from now on; raises ``key_changed`` for a new key the pinned one did not sign.
    """
    verify_advert(advert)
    if pinned is None or pinned.sign_pub == advert.sign_pub:
        return advert
    if pinned.user_id != advert.user_id or pinned.device_id != advert.device_id:
        raise SealedError("wrong_device", "the advert is for another user or device")
    if advert.prev_sign_pub == pinned.sign_pub:
        return advert  # a rotation the pinned key countersigned
    raise SealedError("key_changed", "the device's key changed without being signed by its previous key")


# ── sealing ─────────────────────────────────────────────────────────────────


def _header(env: SealedValueSpec) -> dict:
    return env.model_dump(mode="json", exclude={"nonce", "ciphertext", "sig"})


def _signed_body(env: SealedValueSpec) -> bytes:
    return _canon(env.model_dump(mode="json", exclude={"sig"}))


def _wrap_key(shared: bytes, device_id: str, key_id: str) -> bytes:
    info = _WRAP_INFO + device_id.encode() + b"|" + key_id.encode()
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=info).derive(shared)


def seal(
    sender: DeviceKeyPair,
    *,
    sender_user_id: str,
    sender_device_id: str,
    conversation_id: str,
    recipients: Iterable[DeviceKeyAdvertSpec],
    credential_name: str,
    values: Mapping[str, object],
    credential_title: str = "",
    now: Optional[datetime] = None,
    ttl: timedelta = SEALED_TTL,
) -> SealedValueSpec:
    """One envelope for every recipient device. Each advert must verify; values are read once and not kept."""
    devices = list(recipients)
    if not devices:
        raise SealedError("no_recipient", "nobody to seal for")
    for advert in devices:
        verify_advert(advert)
    now = now or _now()
    eph = X25519PrivateKey.generate()
    dek = ChaCha20Poly1305.generate_key()
    wrapped = []
    for advert in devices:
        shared = eph.exchange(X25519PublicKey.from_public_bytes(_unb64(advert.enc_pub)))
        nonce = os.urandom(12)
        kek = _wrap_key(shared, advert.device_id, advert.key_id)
        wrapped.append(
            SealedRecipientSpec(
                device_id=advert.device_id,
                key_id=advert.key_id,
                nonce=_b64(nonce),
                wrapped_key=_b64(ChaCha20Poly1305(kek).encrypt(nonce, dek, advert.device_id.encode())),
            )
        )
    env = SealedValueSpec(
        transfer_id=mint_uuid(),
        conversation_id=conversation_id,
        sender_user_id=sender_user_id,
        sender_device_id=sender_device_id,
        eph_pub=_b64(_raw_pub(eph.public_key())),
        expires_at=_iso(now + ttl),
        recipients=wrapped,
    )
    plain = {
        "credential_name": credential_name,
        "credential_title": credential_title,
        "values": {k: (v.get_secret_value() if isinstance(v, SecretStr) else str(v)) for k, v in values.items()},
    }
    nonce = os.urandom(12)
    ciphertext = ChaCha20Poly1305(dek).encrypt(nonce, _canon(plain), _canon(_header(env)))
    env = env.model_copy(update={"nonce": _b64(nonce), "ciphertext": _b64(ciphertext)})
    return env.model_copy(update={"sig": _b64(sender.sign.sign(_signed_body(env)))})


def verify_envelope(env: SealedValueSpec, sender_advert: DeviceKeyAdvertSpec, *, sender_user_id: str) -> None:
    """Signed by the device the hub says sent it. ``sender_user_id`` is the hub-stamped sender, never the envelope's
    own claim alone."""
    if env.suite != SUITE_V1:
        raise SealedError("unknown_suite", f"unknown cipher suite {env.suite!r}")
    if env.sender_user_id != sender_user_id or sender_advert.user_id != sender_user_id:
        raise SealedError("wrong_sender", "the sealed value is not from the member who sent it")
    if env.sender_device_id != sender_advert.device_id:
        raise SealedError("wrong_sender", "the sealed value names another device of the sender")
    try:
        Ed25519PublicKey.from_public_bytes(_unb64(sender_advert.sign_pub)).verify(_unb64(env.sig), _signed_body(env))
    except (InvalidSignature, ValueError) as e:
        raise SealedError("bad_signature", "the sealed value's signature does not verify") from e


def open_sealed(
    env: SealedValueSpec,
    keyring: DeviceKeyring,
    *,
    device_id: str,
    sender_advert: DeviceKeyAdvertSpec,
    sender_user_id: str,
    conversation_id: str,
    seen: Iterable[str] = (),
    now: Optional[datetime] = None,
) -> SealedPayloadSpec:
    """Verify, then decrypt for this device. Raises :class:`SealedError` with a code the card can explain."""
    verify_envelope(env, sender_advert, sender_user_id=sender_user_id)
    if env.conversation_id != conversation_id:
        raise SealedError("wrong_conversation", "the sealed value belongs to another conversation")
    if datetime.fromisoformat(env.expires_at) <= (now or _now()):
        raise SealedError("expired", "the sealed value expired")
    if env.transfer_id in set(seen):
        raise SealedError("replayed", "this sealed value was already opened")
    mine = next((r for r in env.recipients if r.device_id == device_id), None)
    if mine is None:
        raise SealedError("not_for_me", "the sealed value is not addressed to this device")
    keys = keyring.by_key_id(mine.key_id)
    if keys is None:
        raise SealedError("key_gone", "this device no longer holds the key the value was sealed to")
    try:
        shared = keys.enc.exchange(X25519PublicKey.from_public_bytes(_unb64(env.eph_pub)))
        kek = _wrap_key(shared, device_id, mine.key_id)
        dek = ChaCha20Poly1305(kek).decrypt(_unb64(mine.nonce), _unb64(mine.wrapped_key), device_id.encode())
        plain = ChaCha20Poly1305(dek).decrypt(_unb64(env.nonce), _unb64(env.ciphertext), _canon(_header(env)))
    except (InvalidTag, ValueError) as e:
        raise SealedError("undecryptable", "the sealed value could not be opened") from e
    data = json.loads(plain)
    return SealedPayloadSpec(
        credential_name=str(data["credential_name"]),
        credential_title=str(data.get("credential_title") or ""),
        values={str(k): SecretStr(str(v)) for k, v in (data.get("values") or {}).items()},
    )


__all__ = [
    "SEALED_TTL",
    "DeviceKeyPair",
    "DeviceKeyring",
    "SealedError",
    "accept_advert",
    "key_id_of",
    "make_advert",
    "open_sealed",
    "seal",
    "verify_advert",
    "verify_envelope",
]
