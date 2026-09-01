"""Change detection for ingested records.

The digest is what makes a steady-state poll cost one HTTP call and zero
writes: an item whose digest is unchanged is not saved, not re-indexed, and
not announced.

Two rules, both learned from other people's outages:

**Hash an allowlist, never the raw payload.** Provider payloads carry fields
that move on their own — vote counts, reaction counts, reply-id lists, signed
URLs whose token rotates, re-serialized whitespace. Digesting those makes every
record look changed on every poll, which re-embeds the corpus nightly and
re-fires every trigger. Airweave excludes ``url`` for exactly this reason;
LlamaIndex hashes the whole metadata dict and pays for it. An allowlist makes
volatility opt-in rather than a bug you discover in your bill.

**Canonicalise before hashing.** Sorted keys, fixed separators — reusing
``canonical_entity_bytes``, which already owns that contract for DB-only entity
hashing and declares its serialization frozen. Two independent canonicalisers
would have to stay byte-identical by convention, with nothing enforcing it.
"""
from __future__ import annotations

from typing import Any

from flow_sdk.fs_store.serializer.db import digest_over

#: The fields that define a record's identity-as-content. Adding one changes
#: every digest and re-writes the corpus once; that is a deliberate act, which
#: is why the list is explicit and lives here rather than being derived.
DIGESTED_FIELDS: tuple[str, ...] = (
    "kind",
    "name",
    "body",
    "occurred_at",
    "author_external_id",
    "author_display",
    "permalink",
    "thread_key",
)


def content_digest(item: Any) -> str:
    """Stable sha256 over the normalized fields of an item."""
    return digest_over(item, DIGESTED_FIELDS)
