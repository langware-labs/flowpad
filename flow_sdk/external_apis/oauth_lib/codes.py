import base64
import hashlib
import secrets


def generate_code_verifier() -> str:
    return secrets.token_urlsafe(32)


def compute_code_challenge(code_verifier: str) -> str:
    # Compute SHA256 hash and encode using URL-safe Base64 without padding.
    digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
    code_challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return code_challenge
