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
from math import ceil
from typing import ClassVar, Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.core import action as core_action
from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp
from flow_sdk.ingest.health import SourceHealth
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse
from flow_sdk.schema.types import EntityType
from flow_sdk.utils.serialization import iso_to_utc

#: The heartbeat ticks once a minute, and every provider floor we care about is
#: at least that. A source may ask for less frequent polling, never more.
MIN_POLL_INTERVAL_SECONDS = 60


def parse_since(raw: str) -> "tuple[Optional[datetime], Optional[str]]":
    """``(datetime, None)`` or ``(None, problem)`` for a replay's ``since``.

    A module function rather than inline parsing because it is the one place a
    bad date must be rejected LOUDLY. Silently treating an unparseable date as
    "no date" would turn a bounded replay into a full one — deleting every
    record when the operator asked for a week's worth.

    A naive datetime is read as UTC, matching every other timestamp on this
    entity (``is_due``, ``window_floor``).
    """
    raw = (raw or "").strip()
    if not raw:
        return None, None
    parsed = iso_to_utc(raw)
    if parsed is None:
        return None, f"since is not an ISO-8601 datetime: {raw!r}"
    return parsed, None


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
    # The addresses/handles that are ME on this source. A record authored by
    # one of them is mine, and the inbox projection must attribute it to the
    # local user — otherwise my own Sent mail counts as unread mail from a
    # stranger, because both unread formulas gate on the sender.
    #
    # A list, not a single value: one mailbox commonly answers to several
    # addresses (aliases, a group address, plus-addressing). Separate from
    # `account_key`, which names the remote account this source serves. That is
    # descriptive only — ids are uuid4 and several sources may serve one
    # account, so nothing dedupes on it and correcting it is a plain edit.
    account_identities: list[str] = APIField(
        default_factory=list, description="Addresses that identify the local user on this source"
    )

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
    # Three primitives, because "reset" is genuinely three different intents and
    # conflating them produces surprises:
    #
    #   poll_now       — go now, keep everything we know
    #   reset_cursors  — forget our position, keep the records
    #   purge_items    — forget the records
    #
    # `reset_cursors` ALONE looks broken, and that is not a bug in the action:
    # re-ingestion resolves each record by its natural key and the digest gate
    # suppresses a row whose content has not moved, so re-reading the same window
    # finds the same rows and the same digests and writes nothing.
    #
    # `replay` is the composite the UI actually offers, because "re-fetch this"
    # is one intent that needs two of the primitives (plus a window widening when
    # it is date-bounded). The primitives stay public: they are separately
    # meaningful, and a caller that wants exactly one should not have to reach
    # for a verb that does two.

    @core_action.post(action_name="poll_now")
    async def poll_now_action(self) -> ApiResponse:
        """POST /api/v1/graph/data_source/{id}/poll_now — make this source due.

        Also the ONLY un-latch for ``config_error``: ``is_due`` refuses a source
        in that state, so without clearing health here a source that hit a
        transient misconfiguration would never poll again.

        Not synchronous — the poller runs off the once-a-minute heartbeat, so
        this means "on the next tick", within 60s. Deliberately not sped up.
        """
        self._make_due()
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
        streams = await self._reset_cursors()
        self.next_poll_at = None
        await self.save()
        return ApiSuccessResponse(data={
            "status": "reset", "streams": streams,
            "detail": "position cleared; existing records still gate on content digest — "
                      "pair with purge_items for a visible re-fetch",
        })

    @core_action.post(action_name="purge_items")
    async def purge_items_action(self) -> ApiResponse:
        """POST /api/v1/graph/data_source/{id}/purge_items — drop the records.

        Safe to pair with a re-poll: re-ingestion rebuilds an equivalent row per
        record. NOT the *same* row — the rebuilt rows are new entities with new
        ids, so anything holding a SourceItem id across a purge is holding a
        dangling reference. It also discards local state (``read`` / ``starred``),
        which is the cost operators actually feel.
        """
        from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415

        removed = await self.purge_records_of(self.id)
        return ApiSuccessResponse(data={"status": "purged", "removed": removed})

    @core_action.post(action_name="replay")
    async def replay_action(self) -> ApiResponse:
        """POST /api/v1/graph/data_source/{id}/replay — re-fetch, optionally from a date.

        Body: ``{"since": "<ISO-8601>"}`` (optional).

        The composite verb, because "re-fetch this" is ONE intent that needs two
        primitives: dropping the records AND clearing the cursor position.
        Either alone is invisible — clearing position re-reads a window whose
        records are already present and digest-identical, and dropping records
        without clearing position means the next poll never re-reads them.

        With ``since`` it also widens ``window_days`` to cover the date, because
        the window floor is what the driver filters on: asking to replay from six
        weeks ago against a 7-day window would silently return nothing. Widen
        only — shrinking here would quietly reduce what every *future* poll sees,
        which is a different decision than the one being made.

        Not synchronous: like ``poll_now`` this makes the source due, and the
        heartbeat picks it up within 60s. No wait, no retry, no backoff.

        Declares no parameters, deliberately. This module carries
        ``from __future__ import annotations`` and the dispatcher resolves an
        annotated request by IDENTITY (``param.annotation is Request``,
        server/routes/graph.py) — under postponed evaluation the annotation is
        the *string* ``'Request'``, no match is found, and the action 400s with
        "Missing required argument: request" while every direct-call test still
        passes. The body comes from ``get_current_request_info`` instead, and
        the work lives in ``replay`` so callers (and tests) can drive it
        without a request at all.
        """
        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        raw_since = str((body or {}).get("since") or "").strip()

        since, problem = parse_since(raw_since)
        if problem:
            return ApiFailResponse(message=problem)

        return ApiSuccessResponse(data=await self.replay(since=since))

    async def replay(self, *, since: Optional[datetime] = None) -> dict:
        """The replay body — see ``replay_action`` for what it means and why."""
        removed = await self.purge_records_of(self.id, since=since)
        streams = await self._reset_cursors()

        widened = False
        if since is not None:
            needed = max(1, ceil((datetime.now(timezone.utc) - since).total_seconds() / 86400))
            if needed > self.window_days:
                self.window_days = needed
                widened = True

        # A parked source would otherwise accept the replay and then never poll
        # to act on it.
        self._make_due()
        await self.save()

        return {
            "status": "replaying",
            "removed": removed,
            "streams": streams,
            "since": since.isoformat() if since else None,
            "window_days": self.window_days,
            "window_widened": widened,
            "detail": "queued for the next heartbeat tick (≤60s)",
        }

    # ── deletion cascades, on BOTH paths ──────────────────────────────────────
    #
    # Nothing cascades on its own: cursors are separate rows (``reset_cursors``
    # deliberately keeps them) and so are the records (only ``purge_items``
    # removes those). Deleting just this row leaves both orphaned, keyed to an id
    # that no longer resolves — invisible until someone counts rows.
    #
    # It has to be hooked on EVERY path, because they do not share one: the HTTP
    # route calls the CLASSMETHOD `delete_by_id` and never constructs the
    # instance (so an instance-only override silently does nothing over the wire
    # while direct-call tests pass — the trap `_close_orphan_tabs_for` documents
    # in `Entity.delete_by_id`), while in-process callers say `delete()` and
    # `destroy()` reaches the record rather than `delete()`. One body, three
    # thin hooks.

    @classmethod
    async def purge_records_of(
        cls, source_id: str, *, since: Optional[datetime] = None
    ) -> int:
        """Drop a source's records; with ``since``, only those at/after it.

        Undated records are KEPT by a bounded replay. ``occurred_at`` is the
        ordering key and a row without one cannot be shown to fall inside the
        window — deleting it on a "since yesterday" replay would silently drop
        data the operator never asked about. That falls out of the query: a
        `>=` comparison never matches a missing value, and ISO-8601 strings
        order lexicographically, so the filter is pushed into SQL rather than
        loading every row to re-parse its date in Python.
        """
        from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415

        if since is None:
            doomed = await SourceItem.get_all({"data_source_id": source_id})
        else:
            doomed = await SourceItem.get_all(
                QueryFilter(match=ExpressionNode(op=QueryOp.AND, operands=[
                    ExpressionNode(op=QueryOp.EQ, operands=["data_source_id", source_id]),
                    ExpressionNode(op=QueryOp.GE, operands=["occurred_at", since.isoformat()]),
                ]))
            )
        for item in doomed:
            await item.destroy()
        return len(doomed)

    @classmethod
    async def delete_children_of(cls, source_id: str) -> None:
        """Every row keyed to this source — the records AND the cursors."""
        from flow_sdk.builtin.data_source_cursor import DataSourceCursor  # noqa: PLC0415

        await cls.purge_records_of(source_id)
        for cursor in await DataSourceCursor.get_all({"data_source_id": source_id}):
            await cursor.destroy()

    @classmethod
    async def delete_by_id(cls, eid: str):
        """The path `DELETE /api/v1/graph/data_source/{id}` takes."""
        await cls.delete_children_of(str(eid))
        return await super().delete_by_id(eid)

    async def delete(self):
        """The verb in-process callers actually use."""
        await self.delete_children_of(self.id)
        await super().delete()

    async def destroy(self) -> None:
        """Routes through the fs-record, so it does not pass through `delete`."""
        await self.delete_children_of(self.id)
        await super().destroy()

    # ── shared bodies — the actions above are thin wrappers over these ────────

    def _make_due(self) -> None:
        """Make this source due on the next tick, clearing any error latch.

        THE un-latch. `is_due` refuses a `config_error` source, so a parked
        source that is not cleared here accepts the operator's verb and then
        never polls to act on it. One copy, because a second one diverges —
        the rule `SourceError.for_status` states in `ingest/health.py`.
        """
        self.next_poll_at = None
        if self.health == SourceHealth.CONFIG_ERROR.value:
            self.health = SourceHealth.NEVER_SYNCED.value if self.last_synced_at is None \
                else SourceHealth.OK.value
        self.error_code = None
        self.error_detail = None

    async def _reset_cursors(self) -> int:
        """Clear every cursor's position, keeping the rows. Returns the count."""
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
        return len(cursors)
