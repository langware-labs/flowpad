"""A passkey's answer to a turn-on challenge (``core/compute/access_key_verify``), checked with a REAL software
authenticator: a P-256 key, COSE key bytes, authenticator data and a DER ECDSA signature made here.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import struct

import cbor2
import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec

from flow_sdk.core.compute import access_key_verify
from flow_sdk.core.compute.access_key_verify import AssertionRefused, verify_passkey_assertion

RP_ID = "hub.example.test"
ORIGIN = "https://hub.example.test"
UP, UV = 0x01, 0x04


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def new_challenge() -> str:
    return b64url(os.urandom(32))


class Passkey:
    """One credential, answering the way a browser and a platform authenticator do (``toJSON()`` shape)."""

    def __init__(self) -> None:
        self.private_key = ec.generate_private_key(ec.SECP256R1())
        self.credential_id = os.urandom(32)

    def record(self, sign_count: int = 0) -> dict:
        """The key as this machine stores it: the hub's ``credential_id`` and ``public_key`` (COSE, ES256)."""
        numbers = self.private_key.public_key().public_numbers()
        cose = {1: 2, 3: -7, -1: 1, -2: numbers.x.to_bytes(32, "big"), -3: numbers.y.to_bytes(32, "big")}
        return {
            "credential_id": b64url(self.credential_id),
            "public_key": b64url(cbor2.dumps(cose)),
            "algorithm": -7,
            "sign_count": sign_count,
        }

    def answer(
        self,
        challenge: str,
        *,
        origin: str = ORIGIN,
        rp_id: str = RP_ID,
        flags: int = UP | UV,
        counter: int = 1,
        kind: str = "webauthn.get",
        signer: ec.EllipticCurvePrivateKey | None = None,
    ) -> dict:
        auth_data = hashlib.sha256(rp_id.encode()).digest() + bytes([flags]) + struct.pack(">I", counter)
        client_data = json.dumps(
            {"type": kind, "challenge": challenge, "origin": origin, "crossOrigin": False}, separators=(",", ":")
        ).encode()
        signed = auth_data + hashlib.sha256(client_data).digest()
        signature = (signer or self.private_key).sign(signed, ec.ECDSA(hashes.SHA256()))
        return {
            "id": b64url(self.credential_id),
            "rawId": b64url(self.credential_id),
            "type": "public-key",
            "authenticatorAttachment": "platform",
            "clientExtensionResults": {},
            "response": {
                "clientDataJSON": b64url(client_data),
                "authenticatorData": b64url(auth_data),
                "signature": b64url(signature),
            },
        }


def verify(passkey: Passkey, assertion: dict, challenges: list[str], *, sign_count: int = 0) -> tuple[str, int]:
    return verify_passkey_assertion(
        passkey.record(sign_count), assertion, challenges=challenges, rp_id=RP_ID, origins=[ORIGIN]
    )


def refusal(passkey: Passkey, assertion: dict, challenges: list[str], *, sign_count: int = 0) -> str:
    with pytest.raises(AssertionRefused) as refused:
        verify(passkey, assertion, challenges, sign_count=sign_count)
    return refused.value.reason


def test_a_good_answer_names_its_challenge_and_the_new_counter():
    passkey = Passkey()
    other, challenge = new_challenge(), new_challenge()
    assert verify(passkey, passkey.answer(challenge, counter=5), [other, challenge], sign_count=4) == (challenge, 5)
    assert verify(passkey, passkey.answer(challenge, counter=0), [challenge]) == (challenge, 0), "a synced passkey"


def test_an_answer_to_another_challenge_is_refused():
    passkey = Passkey()
    live = new_challenge()
    assert refusal(passkey, passkey.answer(new_challenge()), [live]) == access_key_verify.NO_LIVE_CHALLENGE
    assert refusal(passkey, passkey.answer(live), []) == access_key_verify.NO_LIVE_CHALLENGE


def test_a_challenge_swapped_after_signing_is_refused():
    passkey = Passkey()
    signed_for, live = new_challenge(), new_challenge()
    assertion = passkey.answer(signed_for)
    forged = json.dumps({"type": "webauthn.get", "challenge": live, "origin": ORIGIN}, separators=(",", ":"))
    assertion["response"]["clientDataJSON"] = b64url(forged.encode())
    assert refusal(passkey, assertion, [live]) == access_key_verify.NOT_VERIFIED


@pytest.mark.parametrize(
    "made",
    [
        {"origin": "https://evil.example.test"},
        {"origin": "http://hub.example.test"},
        {"rp_id": "evil.example.test"},
        {"flags": UP},
        {"flags": UV},
        {"kind": "webauthn.create"},
        {"signer": ec.generate_private_key(ec.SECP256R1())},
    ],
    ids=["origin", "scheme", "rp-id", "no-user-verification", "no-user-presence", "create-type", "another-key"],
)
def test_a_wrong_answer_is_refused(made):
    passkey = Passkey()
    challenge = new_challenge()
    assert refusal(passkey, passkey.answer(challenge, **made), [challenge]) == access_key_verify.NOT_VERIFIED


def test_a_replayed_counter_is_refused():
    passkey = Passkey()
    challenge = new_challenge()
    replay = refusal(passkey, passkey.answer(challenge, counter=4), [challenge], sign_count=4)
    assert replay == access_key_verify.NOT_VERIFIED


def test_an_answer_made_with_another_credential_is_refused():
    passkey, stranger = Passkey(), Passkey()
    challenge = new_challenge()
    assert refusal(passkey, stranger.answer(challenge), [challenge]) == access_key_verify.WRONG_KEY


def test_what_is_not_an_assertion_is_refused():
    passkey = Passkey()
    challenge = new_challenge()
    good = passkey.answer(challenge)
    no_signature = {**good, "response": {k: v for k, v in good["response"].items() if k != "signature"}}
    not_json = {**good, "response": {**good["response"], "clientDataJSON": b64url(b"not json")}}
    for broken in ({}, "text", no_signature, not_json):
        assert refusal(passkey, broken, [challenge]) == access_key_verify.MALFORMED
    cut_short = {**good, "response": {**good["response"], "authenticatorData": b64url(b"short")}}
    assert refusal(passkey, cut_short, [challenge]) == access_key_verify.NOT_VERIFIED
