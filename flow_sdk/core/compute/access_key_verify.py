"""Check a passkey's answer to a turn-on challenge of this machine (``core/compute/access_keys``).

The machine made the challenge and holds the public key it accepted, so it verifies the answer itself: no hub
call. One pure function; the store and the clock stay with the caller.
"""

from __future__ import annotations

from webauthn import base64url_to_bytes, verify_authentication_response
from webauthn.helpers import parse_authentication_credential_json, parse_client_data_json

MALFORMED = "the answer is not a passkey assertion"
WRONG_KEY = "the answer was not made with this key"
NO_LIVE_CHALLENGE = "the answer is for no live challenge of this machine"
NOT_VERIFIED = "the answer did not verify"


class AssertionRefused(Exception):
    """The passkey answer is not accepted. ``reason`` is one of this module's constants; ``detail`` is for the log."""

    def __init__(self, reason: str, detail: str = "") -> None:
        super().__init__(f"{reason}: {detail}" if detail else reason)
        self.reason = reason
        self.detail = detail


def base64url_bytes(value: object) -> bytes | None:
    """The bytes of a base64url string, or None when it is not one."""
    if not isinstance(value, str) or not value:
        return None
    try:
        return base64url_to_bytes(value)
    except ValueError:  # binascii.Error is a ValueError
        return None


def verify_passkey_assertion(
    key_record: dict,
    assertion: dict,
    *,
    challenges: list[str],
    rp_id: str,
    origins: list[str],
) -> tuple[str, int]:
    """Verify ``assertion`` (an ``AuthenticationResponseJSON``) against an accepted key of this machine.

    ``key_record`` is the stored key: ``credential_id`` and ``public_key`` (base64url COSE key bytes), and the
    ``sign_count`` of its last verified answer. ``challenges`` are the live challenges (base64url); the one the
    answer was signed over is read from its ``clientDataJSON`` and must be one of them.

    Answers ``(that challenge, the new sign count)``. Raises :class:`AssertionRefused` otherwise: the signature,
    the RP ID, the origin, the ``webauthn.get`` type, user presence AND user verification are all required.
    """
    if not isinstance(assertion, dict):
        raise AssertionRefused(MALFORMED, "not a JSON object")
    try:
        credential = parse_authentication_credential_json(assertion)
        client_data = parse_client_data_json(credential.response.client_data_json)
    except Exception as e:  # noqa: BLE001 — bytes from outside: the library raises its own errors and decoders' too
        raise AssertionRefused(MALFORMED, str(e)) from e

    key_id = base64url_bytes(key_record.get("credential_id"))
    public_key = base64url_bytes(key_record.get("public_key"))
    if key_id is None or public_key is None:
        raise AssertionRefused(WRONG_KEY, "the stored key has no credential id or public key")
    if credential.raw_id != key_id:
        raise AssertionRefused(WRONG_KEY, "the credential id is another key's")

    answered = next((c for c in challenges if base64url_bytes(c) == client_data.challenge), None)
    if answered is None:
        raise AssertionRefused(NO_LIVE_CHALLENGE)

    stored_count = key_record.get("sign_count")
    try:
        verified = verify_authentication_response(
            credential=credential,
            expected_challenge=client_data.challenge,
            expected_rp_id=rp_id,
            expected_origin=list(origins),
            credential_public_key=public_key,
            credential_current_sign_count=stored_count if type(stored_count) is int and stored_count > 0 else 0,
            require_user_verification=True,
        )
    except Exception as e:  # noqa: BLE001 — as above; anything but a clean verification is a refusal
        raise AssertionRefused(NOT_VERIFIED, str(e)) from e
    return answered, verified.new_sign_count
