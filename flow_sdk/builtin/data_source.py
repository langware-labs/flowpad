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
from flow_sdk.ingest.health import SourceHealth
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
