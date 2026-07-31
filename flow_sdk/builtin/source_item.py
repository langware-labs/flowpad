"""SourceItem — one record ingested from a cloud DataSource.

Generic and discriminated by ``kind`` (``content.feed.item``, later
``content.message.chat``) rather than one entity type per provider: providers
differ only in ``kind`` and ``raw``, and a single queryable table is what any
later projection over ingested records will need.

**Identity is deterministic.** ``allocate_deterministic_id`` mints a v5 id from
``(data_source, stream, external id)``, so a re-poll, a replay and a
reconciliation sweep all converge on the same row — idempotency with no delivery
ledger and no dedupe table. Same reasoning as
``MessageAttachment.allocate_deterministic_id``.

**Snapshot vs local state.** Snapshot fields are refreshed from the provider
whenever the content digest moves; ``read`` and ``starred`` are ours and must
survive re-delivery, which is why the ingestor writes an explicit field map
rather than replacing the row.
"""
from __future__ import annotations

from typing import ClassVar, Optional

from flow_sdk.api.api_types.api_field import APIField, Persist, Sharing
from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType


class SourceItem(Entity):
    type: str = APIField(default=EntityType.SOURCE_ITEM.value)

    # ── envelope (the routing header) ──────────────────────────────────────
    kind: str = APIField(default="", description="Ontology kind, e.g. content.feed.item")
    provider: str = APIField(default="", description="Driver key: rss | hackernews | …")
    data_source_id: str = APIField(default="")
    stream_key: str = APIField(default="", description="Feed URL, channel id — the cursor's unit")
    stream_label: str = APIField(default="")
    external_id: str = APIField(default="", description="Provider-native stable id")
    thread_key: Optional[str] = APIField(default=None, description="Grouping axis for a later inbox view")
    permalink: Optional[str] = APIField(default=None)
    occurred_at: Optional[str] = APIField(default=None, description="ISO-8601; the ordering key")

    # ── who ────────────────────────────────────────────────────────────────
    author_external_id: Optional[str] = APIField(default=None)
    author_display: Optional[str] = APIField(default=None)

    # ── body ───────────────────────────────────────────────────────────────
    # `name` (declared on Entity) is the FTS title. `body` must reach FTS, which
    # is why it is in SourceItemMeta — see the type_info module.
    body: str = APIField(default="")
    # The provider payload, verbatim. Persist.FALSE keeps it a DB column: it
    # never lands in metadata.json and never pollutes the FTS row.
    raw: Optional[dict] = APIField(default=None, persist=Persist.FALSE, sharing=Sharing.PRIVATE)

    # ── idempotency ────────────────────────────────────────────────────────
    # sha256 over the NORMALIZED fields only, never over `raw` — provider
    # payloads carry volatile keys (scores, reaction counts, re-serialized
    # whitespace) that would flip the digest on every poll and defeat the gate.
    content_digest: str = APIField(default="")

    # ── local state — PRESERVED across re-delivery ─────────────────────────
    read: bool = APIField(default=False)
    starred: bool = APIField(default=False)

    _api_visible: ClassVar[bool] = True

    @staticmethod
    def allocate_deterministic_id(data_source_id: str, stream_key: str, external_id: str) -> str:
        """v5 id from (source, stream, external id) — re-ingest upserts the same row.

        ``stream_key`` is part of the key because provider ids are frequently
        only unique *within* a stream (a Slack ``ts`` repeats across channels),
        and ``data_source_id`` because the same remote feed added twice must not
        collide.
        """
        return mint_uuid(f"source_item:{data_source_id}:{stream_key}:{external_id}")
