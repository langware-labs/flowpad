"""DataSource — a configured remote system of record we sync from.

The filesystem indexer walks roots; this walks a remote API. One DataSource owns
the relationship with one remote account or feed set: which driver, what it needs
to run, how often, and how far back.

**Not project-scoped in phase 1.** When that changes, note that ``Entity``'s
scope resolution reads the current *request* context and a scheduler tick has
none — so it will have to be a persisted field, set explicitly by whoever
creates the source, not inferred at save time.

**"MAY require a connector"** is ``required_capabilities`` plus
``capability_available`` — the same gate ``Journey.gate_open`` uses. An empty
list polls unconditionally, which is what makes "may" real rather than
aspirational, and is exactly the phase-1 (credential-free) path.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import ClassVar, Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.core import Entity
from flow_sdk.core import action as core_action
from flow_sdk.ingest.health import SourceHealth
from flow_sdk.responses.response import ApiResponse, ApiSuccessResponse
from flow_sdk.schema.types import EntityType

#: The heartbeat ticks once a minute, and every provider floor we care about is
#: at least that. A source may ask for less frequent polling, never more.
MIN_POLL_INTERVAL_SECONDS = 60


class DataSource(Entity):
    type: str = APIField(default=EntityType.DATA_SOURCE.value)

    # ── identity / ontology ──
    name: str = APIField(default="")
    kind: str = APIField(default="", description="Ontology kind, e.g. datasource.feed.rss")
    provider: str = APIField(default="", description="Driver registry key: rss | hackernews")
    account_key: str = APIField(default="", description="The remote account/feed-set identity")
    # The user-facing CHANNEL — gmail | slack | jira. Deliberately NOT
    # `provider`, which is the driver/transport key and is literally "agent"
    # for the harness-backed sources. One channel may have several transports
    # (a harness Gmail source and an API one), and threading + the message
    # badge must key on the channel so both resolve to the same thread.
    channel: str = APIField(default="", description="User-facing channel: gmail | slack | jira")

    # ── gating ──
    required_capabilities: list[str] = APIField(
        default_factory=list, description="Capability kinds that must be AVAILABLE to poll"
    )

    # ── driver config — provider-opaque, the subsystem never reads inside ──
    config: dict = APIField(default_factory=dict)

    # ── sync policy ──
    enabled: bool = APIField(default=True)
    poll_interval_seconds: int = APIField(default=300, ge=MIN_POLL_INTERVAL_SECONDS)
    window_days: int = APIField(default=7, ge=1, description="The 'since last pull' floor")
    next_poll_at: Optional[datetime] = APIField(default=None)
    last_synced_at: Optional[datetime] = APIField(default=None)

    # ── health, rolled up worst-of from this source's cursors ──
    health: str = APIField(default=SourceHealth.NEVER_SYNCED.value)
    error_code: Optional[str] = APIField(default=None)
    error_detail: Optional[str] = APIField(default=None)

    _api_visible: ClassVar[bool] = True

    @staticmethod
    def allocate_deterministic_id(provider: str, account_key: str) -> str:
        """v5 id from (provider, account) — re-running setup upserts in place
        rather than minting a second source that would double every poll."""
        return mint_uuid(f"data_source:{provider}:{account_key}")

    def is_due(self, now: Optional[datetime] = None) -> bool:
        now = now or datetime.now(timezone.utc)
        if not self.enabled:
            return False
        if self.health == SourceHealth.CONFIG_ERROR.value:
            # Needs a human. Polling it every minute would burn quota to
            # re-learn something we already know.
            return False
        if self.next_poll_at is None:
            return True
        due = self.next_poll_at
        if due.tzinfo is None:
            due = due.replace(tzinfo=timezone.utc)
        return due <= now

    def window_floor(self, now: Optional[datetime] = None) -> datetime:
        now = now or datetime.now(timezone.utc)
        return now - timedelta(days=self.window_days)

    def schedule_next(self, now: Optional[datetime] = None) -> datetime:
        """Advance ``next_poll_at`` by one interval. THE cadence arithmetic —
        the poller sets it before I/O as a crash guard and the sync loop sets it
        after; both call here so the two can never disagree."""
        now = now or datetime.now(timezone.utc)
        self.next_poll_at = now + timedelta(seconds=self.poll_interval_seconds)
        return self.next_poll_at

    async def capabilities_ready(self) -> bool:
        """Every declared capability is AVAILABLE. Empty list ⇒ always ready."""
        if not self.required_capabilities:
            return True
        from flow_sdk.core.capabilities import capability_available  # noqa: PLC0415

        for kind in self.required_capabilities:
            if await capability_available(kind) is not True:
                return False
        return True

    # ── operator controls ─────────────────────────────────────────────────────
    #
    # Three verbs, because "reset" is genuinely three different intents and
    # conflating them produces surprises:
    #
    #   poll_now       — go now, keep everything we know
    #   reset_cursors  — forget our position, keep the records
    #   purge_items    — forget the records
    #
    # `reset_cursors` ALONE looks broken, and that is not a bug in the action:
    # SourceItem ids are deterministic and the digest gate suppresses a row whose
    # content has not moved, so re-reading the same window re-derives the same
    # ids and the same digests and writes nothing. Re-fetching *visibly* is
    # `purge_items` + `reset_cursors`, which is why the UI offers them together.

    @core_action.post(action_name="poll_now")
    async def poll_now_action(self) -> ApiResponse:
        """POST /api/v1/graph/data_source/{id}/poll_now — make this source due.

        Also the ONLY un-latch for ``config_error``: ``is_due`` refuses a source
        in that state, so without clearing health here a source that hit a
        transient misconfiguration would never poll again.

        Not synchronous — the poller runs off the once-a-minute heartbeat, so
        this means "on the next tick", within 60s. Deliberately not sped up.
        """
        self.next_poll_at = None
        if self.health == SourceHealth.CONFIG_ERROR.value:
            self.health = SourceHealth.NEVER_SYNCED.value if self.last_synced_at is None \
                else SourceHealth.OK.value
        self.error_code = None
        self.error_detail = None
        await self.save()
        return ApiSuccessResponse(data={
            "status": "due", "health": self.health, "enabled": self.enabled,
            "detail": "queued for the next heartbeat tick (≤60s)",
        })

    @core_action.post(action_name="reset_cursors")
    async def reset_cursors_action(self) -> ApiResponse:
        """POST /api/v1/graph/data_source/{id}/reset_cursors — forget position.

        Clears the normalized high-water mark AND the provider-opaque ``state``
        (ETags, update pointers), so the next poll re-reads the whole window.
        Cursor rows are kept rather than deleted: deleting them would also reset
        ``last_synced_at``, flipping the next run to ``first_run`` and therefore
        to BACKFILL — which suppresses per-item events, making a deliberate
        re-fetch silent.
        """
        from flow_sdk.builtin.data_source_cursor import DataSourceCursor  # noqa: PLC0415

        cursors = await DataSourceCursor.get_all({"data_source_id": self.id})
        for cursor in cursors:
            cursor.high_water = None
            cursor.state = {}
            cursor.error_code = None
            cursor.error_detail = None
            cursor.consecutive_failures = 0
            cursor.health = SourceHealth.OK.value
            await cursor.save()
        self.next_poll_at = None
        await self.save()
        return ApiSuccessResponse(data={
            "status": "reset", "streams": len(cursors),
            "detail": "position cleared; existing records still gate on content digest — "
                      "pair with purge_items for a visible re-fetch",
        })

    @core_action.post(action_name="purge_items")
    async def purge_items_action(self) -> ApiResponse:
        """POST /api/v1/graph/data_source/{id}/purge_items — drop the records.

        Safe to pair with a re-poll: ids are ``uuid5(source, stream, external)``
        so re-ingestion rebuilds exactly the same rows. It does discard local
        state (``read`` / ``starred``), which is the real cost of the verb.
        """
        from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415

        items = await SourceItem.get_all({"data_source_id": self.id})
        for item in items:
            await item.destroy()
        return ApiSuccessResponse(data={"status": "purged", "removed": len(items)})
