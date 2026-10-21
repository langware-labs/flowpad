"""AWS Signature Version 4, for one request -- what every S3 call carries, with no AWS SDK.

``sign`` returns the headers to add (``Authorization``, ``x-amz-date``, ``x-amz-content-sha256``,
and ``x-amz-security-token`` for temporary keys). The algorithm is AWS's published one; the tests
pin it against AWS's own example request.
"""

from __future__ import annotations

import hashlib
import hmac
from datetime import datetime, timezone
from typing import Mapping, Optional
from urllib.parse import quote

ALGORITHM = "AWS4-HMAC-SHA256"
EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()


def _hmac(key: bytes, text: str) -> bytes:
    return hmac.new(key, text.encode(), hashlib.sha256).digest()


def _encode(value: str, *, slash: bool) -> str:
    """URI-encode as SigV4 says: every byte but the unreserved ones (``/`` too, unless a path)."""
    return quote(value, safe="-_.~/" if slash else "-_.~")


def canonical_query(params: Mapping[str, str]) -> str:
    pairs = sorted((_encode(str(k), slash=False), _encode(str(v), slash=False)) for k, v in params.items())
    return "&".join(f"{k}={v}" for k, v in pairs)


def sign(method: str, host: str, path: str, params: Mapping[str, str], headers: Mapping[str, str], payload_hash: str, *,
         access_key: str, secret_key: str, region: str, service: str = "s3", session_token: Optional[str] = None,
         now: Optional[datetime] = None, content_header: bool = True) -> dict[str, str]:
    """The headers that sign this request. ``path`` is already the request's encoded path."""
    moment = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    amz_date, day = moment.strftime("%Y%m%dT%H%M%SZ"), moment.strftime("%Y%m%d")
    added = {"x-amz-date": amz_date}
    if content_header:
        added["x-amz-content-sha256"] = payload_hash
    if session_token:
        added["x-amz-security-token"] = session_token
    signed = {k.lower(): " ".join(str(v).split()) for k, v in {**headers, **added, "host": host}.items()}
    names = sorted(signed)
    canonical = "\n".join([
        method.upper(), path or "/", canonical_query(params),
        "".join(f"{name}:{signed[name]}\n" for name in names), ";".join(names), payload_hash,
    ])
    scope = f"{day}/{region}/{service}/aws4_request"
    to_sign = "\n".join([ALGORITHM, amz_date, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    key = _hmac(_hmac(_hmac(_hmac(f"AWS4{secret_key}".encode(), day), region), service), "aws4_request")
    signature = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
    added["Authorization"] = f"{ALGORITHM} Credential={access_key}/{scope}, SignedHeaders={';'.join(names)}, Signature={signature}"
    return added


def encoded_path(*segments: str) -> str:
    """``/bucket/a b/c`` with each segment URI-encoded once (S3 keys keep their ``/``)."""
    return "/" + "/".join(_encode(s, slash=True) for s in segments if s != "")
