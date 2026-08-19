"""SourceItem — one record ingested from a cloud DataSource.

Generic and discriminated by ``kind`` (``content.feed.item``, later
``content.message.chat``) rather than one entity type per provider: providers
differ only in ``kind`` and ``raw``, and a single queryable table is what any
later projection over ingested records will need.

**Identity is the natural key, looked up — not derived.** The id is an ordinary
``uuid4``; what makes a re-poll, a replay and a reconciliation sweep converge on
one row is ``find_existing``, which resolves ``(data_source, stream, external
id)`` to the row that already holds it. Same guarantee as the old v5-derived id
(idempotency with no delivery ledger and no dedupe table), relocated from id
arithmetic to a lookup — so rows written before the change still resolve, and
nothing has to re-derive an id it does not hold.

**Snapshot vs local state.** Snapshot fields are refreshed from the provider
whenever the content digest moves; ``read`` and ``starred`` are ours and must
survive re-delivery, which is why the ingestor writes an explicit field map
rather than replacing the row.
"""
from __future__ import annotations

from typing import ClassVar, Optional

from pydantic import model_validator

from flow_sdk.api.api_types.api_field import APIField, Persist, Sharing
from flow_sdk.core import Entity
from flow_sdk.core.entity.legacy_fields import adopt_renamed
from flow_sdk.schema.types import EntityType


class SourceItem(Entity):
    type: str = APIField(default=EntityType.SOURCE_ITEM.value)

    # ── envelope (the routing header) ──────────────────────────────────────
    kind: str = APIField(default="", description="Ontology kind, e.g. content.feed.item")
    provider: str = APIField(default="", description="Driver key: rss | hackernews | …")
    data_source_id: str = APIField(default="")
    segment_key: str = APIField(default="", description="Feed URL, channel id — the cursor's unit")
    segment_label: str = APIField(default="")
    external_id: str = APIField(default="", description="Provider-native stable id")
    thread_key: Optional[str] = APIField(default=None, description="Grouping axis for the inbox projection")
    # The provider's id for the record this replies to. Provenance for quoting
    # and for repairing a thread whose parent arrives late — NOT how threading
    # is decided (`thread_key` is). Deliberately absent from DIGESTED_FIELDS:
    # it never changes for a given record, and adding a digested field rewrites
    # the whole corpus once. The accepted consequence is that rows ingested
    # before this field existed never backfill it.
    reply_to_external_id: Optional[str] = APIField(default=None)
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

    @model_validator(mode="before")
    @classmethod
    def _adopt_legacy_stream_key(cls, data):
        """Rows written before the segment rename carry ``stream_key``.

        Without this they load with an empty ``segment_key`` — and for
        ``SourceItem`` that is part of the natural key, so every pre-rename
        record would fail to resolve and the next poll would mint a duplicate
        of it. Same shape as ``DataSource._adopt_legacy_enabled``.
        """
        return adopt_renamed(
            data, {"stream_key": "segment_key", "stream_label": "segment_label"}
        )

    @classmethod
    async def find_existing(
        cls, data_source_id: str, segment_key: str, external_id: str
    ) -> Optional["SourceItem"]:
        """THE identity lookup — the row for this natural key, or None.

        ``segment_key`` is part of the key because provider ids are frequently
        only unique *within* a stream (a Slack ``ts`` repeats across channels),
        and ``data_source_id`` because the same remote feed added twice must not
        collide.

        Single-row path, indexed by ``ix_entities_source_item_natural_key``.
        ``ingest_items`` does the same resolution for a whole page in one query
        (``_load_existing``) — use that for anything batched, or a steady-state
        poll pays one SELECT per item just to consult the digest gate.
        """
        return await cls.get_one({
            "data_source_id": data_source_id,
            "segment_key": segment_key,
            "external_id": external_id,
        })
