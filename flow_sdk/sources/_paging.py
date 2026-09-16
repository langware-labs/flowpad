"""Stateless continuation for a ``CollectionSource``: a cursor is "resume after this key",
bound to the query that produced it. The cursor carries nothing the source must remember.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
from bisect import bisect_right
from typing import Any, Optional, Sequence

from flow_sdk.sources.errors import InvalidCursor
from flow_sdk.sources.values.query import DataQuery

MAX_CURSOR_LENGTH = 4096


def query_token(query: Optional[DataQuery]) -> str:
    """A short fingerprint of the query a cursor belongs to."""
    if query is None:
        return ""
    digest = hashlib.blake2b(digest_size=8)
    digest.update(type(query).__qualname__.encode())
    digest.update(query.model_dump_json().encode())
    return digest.hexdigest()


def encode(after: str, token: str) -> str:
    return base64.urlsafe_b64encode(json.dumps([after, token]).encode()).decode()


def decode(cursor: object, token: str) -> str:
    if not isinstance(cursor, str):
        raise TypeError(f"cursor must be a string, got {type(cursor).__name__}")
    if len(cursor) > MAX_CURSOR_LENGTH:
        raise InvalidCursor("cursor is too long")
    try:
        after, owner = json.loads(base64.urlsafe_b64decode(cursor.encode()))
    except (ValueError, TypeError, RecursionError, binascii.Error) as exc:
        raise InvalidCursor("malformed cursor") from exc
    if not isinstance(after, str) or owner != token:
        raise InvalidCursor("cursor does not belong to this query")
    return after


def slice_after(
    entries: Sequence[tuple[str, Any]], after: Optional[str], limit: int
) -> tuple[Sequence[tuple[str, Any]], Optional[str]]:
    """Up to ``limit`` key-sorted entries after ``after``, and the key to resume from."""
    start = 0 if after is None else bisect_right([key for key, _ in entries], after)
    page = entries[start : start + limit]
    more = start + limit < len(entries)
    return page, (page[-1][0] if more and page else None)
