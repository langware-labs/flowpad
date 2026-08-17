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

from typing import TYPE_CHECKING

from flow_sdk.llm_index.core import sha256_bytes
from flow_sdk.semantic_lock.targets import canonical_entity_bytes

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.ingest.models import IngestItem

#: The fields that define a record's identity-as-content. Adding one changes
#: every digest and re-writes the corpus once; that is a deliberate act, which
#: is why the list is explicit and lives here rather than being derived.
DIGESTED_FIELDS: tuple[str, ...] = (
    "kind",
    "title",
    "body",
    "occurred_at",
    "author_external_id",
    "author_display",
    "permalink",
    "thread_key",
)


def content_digest(item: "IngestItem") -> str:
    """Stable sha256 over the normalized fields of ``item``."""
    payload = {name: getattr(item, name, None) for name in DIGESTED_FIELDS}
    return sha256_bytes(canonical_entity_bytes(payload))
