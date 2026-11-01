"""Secured transfer — the shapes that travel (``docs/secret_share.md``, "Between people").

A **device key advert** is one Flowpad install's public keys, self-signed, published to the hub's
device-key directory. A **sealed value** is one transfer of a credential's values, encrypted for the
recipient's devices and signed by the sender's device. Neither carries a value in the clear: the
credential's name and its variables are inside the ciphertext too.
"""

from __future__ import annotations

from typing import ClassVar

from pydantic import Field, SecretStr

from flow_sdk.schema.data_spec.spec import DataSpec

#: The one cipher suite: X25519 + HKDF-SHA256 wrap, ChaCha20-Poly1305 body, Ed25519 signature.
SUITE_V1 = "x25519-hkdf-sha256-chacha20poly1305+ed25519"


class DeviceKeyAdvertSpec(DataSpec):
    """One install's public keys. ``sig`` is the install's Ed25519 signature over every other field."""

    spec_kind: ClassVar[str] = "secrets.device_key"

    v: int = 1
    user_id: str
    #: The install's id (``instance_uid()``) — the hub already knows it as ``desktop-cli:<id>``.
    device_id: str
    device_name: str = ""
    #: Raw 32-byte public keys, base64.
    sign_pub: str
    enc_pub: str
    #: Short fingerprint of ``enc_pub`` — what a sealed value names so the device opens it with the right key
    #: after a rotation.
    key_id: str
    created_at: str
    #: Rotation: the signing key this advert replaces, and that key's signature over this advert. A receiver
    #: that pinned the previous key accepts the new one only through this chain — never a silent swap.
    prev_sign_pub: str = ""
    prev_sig: str = ""
    sig: str = ""


class SealedRecipientSpec(DataSpec):
    """The body key, wrapped for one recipient device."""

    device_id: str
    #: The recipient key this copy is sealed to (``DeviceKeyAdvertSpec.key_id``).
    key_id: str
    nonce: str
    wrapped_key: str


class SealedValueSpec(DataSpec):
    """One transfer. Everything but ``ciphertext``/``nonce``/``sig`` is the AEAD's associated data, so moving
    it to another conversation, another sender or a later expiry breaks it; ``sig`` covers all of it."""

    spec_kind: ClassVar[str] = "secrets.sealed_value"

    v: int = 1
    suite: str = SUITE_V1
    transfer_id: str
    conversation_id: str
    sender_user_id: str
    sender_device_id: str
    eph_pub: str
    expires_at: str
    recipients: list[SealedRecipientSpec] = Field(default_factory=list)
    nonce: str = ""
    ciphertext: str = ""
    sig: str = ""


class SealedPayloadSpec(DataSpec):
    """What a sealed value opens to — held in memory between decrypt and the credential writer only.
    Values are ``SecretStr``: a repr or a log line never shows one."""

    credential_name: str
    credential_title: str = ""
    values: dict[str, SecretStr] = Field(default_factory=dict)


__all__ = ["SUITE_V1", "DeviceKeyAdvertSpec", "SealedPayloadSpec", "SealedRecipientSpec", "SealedValueSpec"]
