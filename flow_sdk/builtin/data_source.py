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

import logging
import re
from datetime import datetime, timedelta, timezone
from math import ceil
from typing import ClassVar, Optional

from pydantic import model_validator

from flow_sdk._compat import StrEnum
from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.builtin.source_item import MessageSpec, SourceItemSpec
from flow_sdk.core import Entity
from flow_sdk.core import action as core_action
from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp
from flow_sdk.fs_store.origin.field import OriginField
from flow_sdk.ingest.driver import SendOutcome, SetupVerdict
from flow_sdk.ingest.health import SourceHealth
from flow_sdk.ingest.reflect import ReflectMode
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse
from flow_sdk.schema.types import EntityType
from flow_sdk.utils.serialization import iso_to_utc

logger = logging.getLogger(__name__)

#: The heartbeat ticks once a minute, and every provider floor we care about is
#: at least that. A source may ask for less frequent polling, never more.
MIN_POLL_INTERVAL_SECONDS = 60


def _normalize_message_id(value: object) -> str:
    """Comparable form of an RFC message id from a send or received header."""
    normalized = "".join(str(value or "").split()).casefold()
    if len(normalized) >= 2 and normalized[0] == "<" and normalized[-1] == ">":
        return normalized[1:-1]
    return normalized


class SourceStatus(StrEnum):
    """Where a source is in its life — a SEPARATE axis from ``health``.

    Status answers "should this be running"; health answers "is it working".
    Collapsing them is how a source ends up reading OK while nobody has finished
    setting it up, or reading broken because a human paused it.

    This replaces the old ``enabled`` boolean, which could only say two of these
    four things. A source awaiting a setup step the user must perform — inviting
    a bot to a Slack channel — is not disabled (nobody turned it off) and not
    active (it would fetch nothing); it is SETUP, and that state has to be
    representable or the UI has to lie about one of them.
    """

    #: Created, not yet evaluated. Transient: the first save resolves it.
    NEW = "new"
    #: Waiting on a human. `setup_detail` says what for.
    SETUP = "setup"
    #: Polling.
    ACTIVE = "active"
    #: Paused by a person. Only a person moves it out.
    DISABLED = "disabled"


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

    # ── origin — WHERE this source's bytes come from ──
    #
    # A typed `FSOrigin` (a `LocalOrigin` at the watched folder / the checkout /
    # the download cache; a `GitOrigin` for a repository that has to be cloned),
    # stamped by the driver's `origin_for` on every save. Reflection reads it —
    # never a provider-specific config key — so the engine holds one fact about
    # where a tree begins, and a `GitOrigin` materializes through the same
    # `FSOriginDriver` bundles and projects use. PRIVATE: a path on this machine.
    origin: OriginField = APIField(default=None, sharing=Sharing.PRIVATE)

    # The mailbox allowlist, cached for the gate that runs on every inbound
    # message (`EmailInbox.allowed`). The HUB owns this policy; this is a copy,
    # refreshed on every reconcile, and it is never read to answer "what is the
    # policy" — only to apply it without a network call.
    #
    # Deliberately NOT inside `config`, for the reason the reflection block below
    # gives: `config` is provider-opaque and shareable, and these are third
    # parties' personal addresses. PRIVATE, like `origin`: a fact about this
    # machine that must not travel to a receiver or back to the hub.
    inbound_allowed_senders: list[str] = APIField(default_factory=list, sharing=Sharing.PRIVATE)

    # ── reflection — HOW the payload becomes locally present ──
    #
    # Deliberately NOT inside `config`: `config` is provider-opaque and the
    # subsystem never reads inside it, but this is read by `sync_source` to pick
    # a destination. A setting the engine must read cannot live in the bag the
    # engine promises not to open.
    #
    # Defaults to `record`, so every shipped driver keeps taking exactly the
    # path it takes today.
    reflect: str = APIField(
        default=ReflectMode.RECORD.value,
        description="record | none | copy | symlink",
    )
    #: The directory reflected assets land under — the `copy`/`symlink` target,
    #: and the clone target for a `GitOrigin`. Empty for `record` and `none`.
    #: An absolute path, set explicitly by whoever configures the source — NOT
    #: resolved from request context, because the heartbeat tick that polls
    #: this row has none (the same trap this module's docstring flags for
    #: project scoping).
    reflect_into: str = APIField(default="")

    # ── lifecycle ──
    status: str = APIField(default=SourceStatus.NEW.value)
    #: What SETUP is waiting for, in the user's words. Empty in every other
    #: state. The card renders this verbatim, so it is a sentence, not a code.
    setup_detail: str = APIField(default="")
    #: When the last verify ran, whatever its verdict.
    verified_at: Optional[datetime] = APIField(default=None)

    # ── sync policy ──
    poll_interval_seconds: int = APIField(default=300, ge=MIN_POLL_INTERVAL_SECONDS)
    window_days: int = APIField(default=7, ge=1, description="The 'since last pull' floor")
    next_poll_at: Optional[datetime] = APIField(default=None)
    last_synced_at: Optional[datetime] = APIField(default=None)

    #: How many streams this source has, rolled up with health so a list can
    #: show it without querying the cursor table. Cursors are the highest-churn
    #: rows on the instance (one write per stream per poll), so a UI that
    #: watches them live to render a COUNT repaints on every tick for a number
    #: that only changes when a stream is added or removed.
    #:
    #: Set by ``_roll_up``, so it reflects the last run that got far enough to
    #: enumerate streams. A source that fails before that — unknown provider, a
    #: missing capability — reads 0 even if it has cursors from an earlier life.
    #: That is the honest reading: those failures happen before the driver is
    #: ever asked what its streams are.
    segment_count: int = APIField(default=0)

    # ── health, rolled up worst-of from this source's cursors ──
    health: str = APIField(default=SourceHealth.NEVER_SYNCED.value)
    error_code: Optional[str] = APIField(default=None)
    error_detail: Optional[str] = APIField(default=None)

    _api_visible: ClassVar[bool] = True

    @model_validator(mode="before")
    @classmethod
    def _adopt_legacy_enabled(cls, data):
        """Rows written before `status` existed carry `enabled` instead.

        Without this they would load with the default status (NEW) and a source
        someone deliberately paused would quietly come back — the one migration
        outcome that is worse than an error.
        """
        if not isinstance(data, dict) or data.get("status"):
            return data
        if "enabled" in data:
            data = dict(data)
            legacy = data.pop("enabled")
            data["status"] = (
                SourceStatus.ACTIVE.value if legacy else SourceStatus.DISABLED.value
            )
        return data

    @property
    def enabled(self) -> bool:
        """Read-compat for callers that still ask the old question.

        Not a field any more — ACTIVE is the only state that polls, so this is
        derived rather than stored. Kept because a boolean reads better than a
        string comparison at a call site that only cares whether it runs.
        """
        return self.status == SourceStatus.ACTIVE.value

    def poll_refusal(self) -> str:
        """Why this source may not be polled, or ``""`` when it may.

        The ONE copy of the "is polling this source allowed at all" gate.
        ``is_due``, ``request_poll`` and the poller's attention fast lane all
        ask the same question; hand-copies drift the moment a new status or
        health state lands. NEW and SETUP have not finished being configured
        and DISABLED is a person's decision — none of them touch health.
        ``config_error`` needs a human; polling it every minute would burn
        quota to re-learn something we already know.

        Answers the SENTENCE, not a boolean. Every caller that refuses has to
        tell somebody why, and a bare yes/no leaves each of them to invent its
        own wording: ``request_poll`` used to answer "attention never wakes a
        parked or non-active source", which is four different reasons wearing
        one coat and tells the reader nothing about which applied. One author
        for the sentence, so the pill, the log line and the API payload cannot
        disagree.
        """
        if self.status == SourceStatus.NEW.value:
            return "this source has not been evaluated yet"
        if self.status == SourceStatus.SETUP.value:
            return self.setup_detail or "this source is waiting on a setup step"
        if self.status == SourceStatus.DISABLED.value:
            return "this source is disabled"
        if self.health == SourceHealth.CONFIG_ERROR.value:
            return "this source is parked on a configuration error"
        return ""

    @classmethod
    async def find_for_account(cls, provider: str, key: str, value: str) -> "Optional[DataSource]":
        """The source of ``provider`` whose ``config[key]`` names ``value``.

        The canonical natural-key lookup (same shape as
        ``SourceItem.find_existing``): callers wanting connect-or-reuse
        semantics ask HERE instead of re-scanning ``get_all`` and filtering by
        hand — the id policy's whole point is that identity is a lookup.
        ``key`` is normally the driver's ``identity_config_key``.
        """
        value = str(value or "").strip()
        for row in await cls.get_all({"provider": provider}):
            current = (row.config or {}).get(key)
            # A `lines` field (Slack's ``channels``) is a list; the source
            # serves the account when the value is one of its entries.
            members = current if isinstance(current, list) else [current]
            if any(str(m or "").strip() == value for m in members):
                return row
        return None

    async def send(self, spec: MessageSpec) -> SendOutcome:
        """Deliver one outbound message through this source's driver.

        Message-shape validation belongs here rather than on each workflow
        surface: a direct SDK caller and ``blocks.Inbox`` must reject the same
        unsupported attachment or recipient shape before provider I/O begins.
        """
        from flow_sdk.builtin.source_item import EmailMessageSpec  # noqa: PLC0415
        from flow_sdk.ingest.driver import get_driver  # noqa: PLC0415

        if spec.attachments:
            raise NotImplementedError(
                "attachments are not supported on this channel yet — "
                "the driver send contract carries text only"
            )
        if len(spec.to) != 1:
            raise ValueError(f"exactly one recipient for now, got {len(spec.to)}")

        driver = get_driver(self.provider)
        if driver is None or not driver.sends:
            raise RuntimeError(f"the {self.provider} driver cannot send")
        return await driver.send(
            self,
            thread_key=spec.thread_key,
            to=spec.to[0],
            text=spec.body,
            subject=spec.subject if isinstance(spec, EmailMessageSpec) else "",
            in_reply_to=spec.reply_to_external_id,
        )

    async def expect_reply(self, sent: SendOutcome) -> SourceItemSpec:
        """Sync until this source contains a reply to ``sent``.

        The caller owns the outer deadline. This method deliberately carries
        no second timeout, retry budget, or sleep that could disagree with it.
        Existing rows are checked before the first provider call so an already
        ingested reply returns without needless network I/O.
        """
        from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415
        from flow_sdk.ingest.driver import get_driver  # noqa: PLC0415
        from flow_sdk.ingest.ingestor import ingest_items  # noqa: PLC0415
        from flow_sdk.ingest.sync import sync_source  # noqa: PLC0415

        expected = _normalize_message_id(sent.external_id)
        if not expected:
            raise ValueError("cannot expect a reply to a send with no external_id")
        driver = get_driver(self.provider)

        while True:
            items = await SourceItem.get_all({"data_source_id": self.id})
            for item in items:
                if _normalize_message_id(item.reply_to_external_id) == expected:
                    return SourceItemSpec.model_validate(
                        {key: getattr(item, key) for key in SourceItemSpec.model_fields}
                    )
            if driver is not None and driver.wait_for_reply is not None:
                reply = await driver.wait_for_reply(self, str(sent.external_id))
                await ingest_items([reply])
                return reply
            if driver is not None and driver.find_reply is not None:
                reply = await driver.find_reply(self, str(sent.external_id))
                if reply is not None:
                    await ingest_items([reply])
                    return reply
            else:
                await sync_source(self, now=datetime.now(timezone.utc))

    def is_due(self, now: Optional[datetime] = None) -> bool:
        now = now or datetime.now(timezone.utc)
        if self.poll_refusal():
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
        after; both call here so the two can never disagree.

        The stamp is QUANTIZED to the minute grid the heartbeat ticks on.
        ``now + interval`` carries this dispatch's millisecond jitter, and the
        next tick's own jitter is independent — so whenever the tick fired a
        few ms earlier than the stamp, the poll silently waited a whole extra
        minute (RCA-proven both directions by moving ``next_poll_at`` across a
        tick boundary: due :00−30s → the boundary tick polled; due :00+0.5s →
        it skipped and polled a minute late). Flooring to the minute makes an
        interval of one tick period mean "every tick", never a coin flip.
        """
        now = now or datetime.now(timezone.utc)
        due = now + timedelta(seconds=self.poll_interval_seconds)
        # The grid is the heartbeat tick — the same once-a-minute cadence
        # MIN_POLL_INTERVAL_SECONDS documents. If the tick period ever
        # changes, this floor must change with it.
        self.next_poll_at = due.replace(second=0, microsecond=0)
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
        return ApiSuccessResponse(data=await self.poll_now())

    async def poll_now(self) -> dict:
        """Make this source due on the next tick — the verb under ``poll_now_action``.

        Thin route, real verb: the pattern ``replay``/``replay_action`` set, so an
        in-process caller never reaches through an HTTP handler to use it.
        """
        await self._make_due()
        await self.save()
        return {
            "status": "due", "health": self.health, "source_status": self.status,
            "detail": "queued for the next heartbeat tick (≤60s)",
        }

    @core_action.post(action_name="request_poll")
    async def request_poll_action(self) -> ApiResponse:
        """POST /api/v1/graph/data_source/{id}/request_poll — attention.

        A viewer is looking at this source's output RIGHT NOW; poll on the
        next heartbeat tick. The UI fires this on an interval while a
        conversation backed by the source is selected — the request stream IS
        the liveness signal, so there is no active/idle state to store,
        round-trip, or decay: when the viewer goes away the requests stop and
        the standing ``poll_interval_seconds`` cadence resumes by itself.

        Deliberately NOT ``poll_now``: that verb is the one un-latch for
        ``config_error``, and an auto-firing viewer must never resurrect a
        parked source (burning quota to re-learn a broken credential) or wake
        a DISABLED one — a human decision outranks a mounted view. Ignored,
        loudly in the payload, for anything that is not a healthy ACTIVE
        source. Idempotent: an already-due source is left due.
        """
        refusal = self.poll_refusal()
        if refusal:
            return ApiSuccessResponse(data={
                "status": "ignored", "health": self.health, "source_status": self.status,
                "detail": refusal,
            })
        if self.next_poll_at is not None:
            self.next_poll_at = None
            await self.save()
        # A driver that tolerates it gets the sub-tick FAST LANE while watched:
        # each request renews a short lease and the poller's attention loop
        # polls at the driver's cadence (telegram: 5s). Drivers that declare
        # nothing stay tick-bound — due on the next minute, no faster.
        driver = self._driver()
        cadence = getattr(driver, "attention_poll_seconds", None) if driver else None
        if cadence:
            from flow_sdk.ingest.poller import note_attention  # noqa: PLC0415

            note_attention(str(self.id), cadence)
        return ApiSuccessResponse(data={
            "status": "due", "health": self.health, "source_status": self.status,
            "attention_seconds": cadence,
            "detail": (
                f"fast lane armed — polling every {cadence}s while watched"
                if cadence else "queued for the next heartbeat tick (≤60s)"
            ),
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
        streams = await self.reset_cursors()
        return ApiSuccessResponse(data={
            "status": "reset", "streams": streams,
            "detail": "position cleared; existing records still gate on content digest — "
                      "pair with purge_items for a visible re-fetch",
        })

    async def reset_cursors(self) -> int:
        """Forget every segment's position and make the source due. Returns streams reset."""
        streams = await self._reset_cursors()
        self.next_poll_at = None
        await self.save()
        return streams

    @core_action.post(action_name="purge_items")
    async def purge_items_action(self) -> ApiResponse:
        """POST /api/v1/graph/data_source/{id}/purge_items — drop the records.

        Safe to pair with a re-poll: re-ingestion rebuilds an equivalent row per
        record. NOT the *same* row — the rebuilt rows are new entities with new
        ids, so anything holding a SourceItem id across a purge is holding a
        dangling reference. It also discards local state (``read`` / ``starred``),
        which is the cost operators actually feel.
        """
        removed = await self.purge_items()
        return ApiSuccessResponse(data={"status": "purged", "removed": removed})

    async def purge_items(self) -> int:
        """Drop this source's records. Returns how many went."""
        return await self.purge_records_of(self.id)

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
        await self._make_due()
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
        if doomed:
            # The inbox side of the purge. Under the reference model the
            # projected FlowMessages hold no body of their own — leaving them
            # behind would fill the inbox with blank rows, so the cascade is
            # mandatory, not hygiene.
            from flow_sdk.inbox.projection import remove_projection_for_items  # noqa: PLC0415

            await remove_projection_for_items([i.id for i in doomed])
        return len(doomed)

    @classmethod
    async def delete_children_of(cls, source_id: str) -> None:
        """Every row keyed to this source — the records AND the cursors."""
        from flow_sdk.builtin.consumer_position import ConsumerPosition  # noqa: PLC0415
        from flow_sdk.builtin.data_source_cursor import DataSourceCursor  # noqa: PLC0415
        from flow_sdk.builtin.source_change import SourceChange  # noqa: PLC0415

        await cls.purge_records_of(source_id)
        await DataSourceCursor.delete_for(source_id)
        await ConsumerPosition.delete_for(source_id)
        await SourceChange.delete_for(source_id)

    @classmethod
    async def delete_by_id(cls, eid: str):
        """The path `DELETE /api/v1/graph/data_source/{id}` takes."""
        await cls.delete_children_of(str(eid))
        return await super().delete_by_id(eid)

    async def save(self, *args, **kwargs):
        """Resolve NEW on the way in, so a source is never stuck un-runnable.

        NEW is transient by design: it means "nobody has decided yet". The
        decision is the driver's — one that declares `verify` has a setup step a
        human must complete (Slack's bot invite), so it starts in SETUP; one that
        does not is ready the moment it is configured, so it starts ACTIVE. That
        keeps a plain RSS feed from demanding a Verify click it has no use for.
        """
        if self.status == SourceStatus.NEW.value:
            # An AUTHORED source's driver comes from a row, not an import, so it
            # may not be registered yet on a cold process. Resolving NEW without
            # it would send a source that HAS a setup step straight to ACTIVE.
            from flow_sdk.ingest.driver import DRIVERS  # noqa: PLC0415
            from flow_sdk.ingest.spec_registry import refresh_spec_drivers  # noqa: PLC0415

            # Only when the answer isn't already in hand: a shipped provider is
            # registered at import, and warming the spec table for it is a DB
            # round trip on a request a person is waiting on.
            if self.provider not in DRIVERS:
                await refresh_spec_drivers(self.provider)
            driver = self._driver()
            if driver is not None and driver.verify is not None:
                self.status = SourceStatus.SETUP.value
                if not self.setup_detail:
                    self.setup_detail = "Finish setup, then press Verify."
            else:
                # Includes an UNKNOWN provider, deliberately: leaving it in NEW
                # would park it silently, while ACTIVE lets the poller reach
                # `sync_source`, which reports `unknown_provider` as a
                # config_error the card can actually explain.
                self.status = SourceStatus.ACTIVE.value
        # ONE spec read per save, shared by the three rules below. Each used
        # to fetch it independently, so a create paid three round trips for the
        # same row on a request a person is waiting on. `_needs_spec` keeps the
        # steady state free: the poller's per-tick re-save reads nothing.
        spec = await self._spec() if self._needs_spec() else None
        self._coerce_config(spec)
        self._validate_config(spec)
        self._coerce_reflect(spec)
        if not (self.channel or "").strip():
            # Stamp the channel at CREATE, not first poll: the credential probe
            # keys on it (Verify on a fresh source probed nothing) and the UI
            # badges by it. `sync_source` keeps re-stamping every poll, so this
            # is the first answer, not a fork of the rule. The driver is asked
            # DIRECTLY — not through `channel_of_driver`, whose provider
            # fallback is indistinguishable from a driver whose channel simply
            # IS its provider name (agentmail). A driver that answers empty
            # (agent transport with no connector yet) stamps nothing.
            driver = self._driver()
            if driver is not None and driver.channel_for is not None:
                try:
                    stamped = str(driver.channel_for(self) or "").strip()
                except Exception:  # noqa: BLE001 — a probe must never fail a save
                    stamped = ""
                if stamped:
                    self.channel = stamped
        self._stamp_origin()
        return await super().save(*args, **kwargs)

    def _needs_spec(self) -> bool:
        """True when any save-time rule below still has a question for the spec.

        A saved row whose config is already typed and whose reflect mode is
        settled has nothing to ask, which is the poller's case on every tick.
        """
        untyped = isinstance(self.config, dict) and any(isinstance(v, str) for v in self.config.values())
        driver = self._driver()
        stuck = self.reflect in ("", ReflectMode.RECORD.value) and driver is not None and driver.origin_for is not None
        return untyped or stuck or not self.exist_in_db

    async def _spec(self) -> "Optional[object]":
        """The provider's definition row, or None when it cannot be resolved —
        an unresolvable spec changes nothing about any of the three rules."""
        from flow_sdk.builtin.data_source_spec import DataSourceSpec  # noqa: PLC0415

        try:
            return await DataSourceSpec.get_one({"name": self.provider})
        except Exception:  # noqa: BLE001 — an unresolvable spec changes nothing
            return None

    def _coerce_config(self, spec) -> None:
        """Shape ``config`` by the definition's field types on save — a URL sent
        as a string where ``lines`` is declared must not produce a source that
        looks configured and fails on its first sync (the rss driver iterating
        the characters of a URL). The rule is the spec's
        (``ConfigFieldSpec.coerce``); this is only where a row applies it, and
        ``save`` is the one gate the dialog, the API and an agent all pass.

        Only a string can need shaping, so a config whose values are already
        typed (the poller re-saves one on every tick) costs one pass over a
        handful of values and never a spec lookup.
        """
        if not isinstance(self.config, dict) or not any(isinstance(v, str) for v in self.config.values()):
            return
        if spec is not None:
            self.config = spec.coerce_config(self.config)

    def _validate_config(self, spec) -> None:
        """The manifest's ``required`` / ``pattern`` rules, applied where the
        dialog cannot see: the API and an agent. The form already refuses a
        blank required field and a value off its regex, so a source created by
        hand could look configured and park on its first sync with a driver
        error the author had to decode. Raises ``ValueError`` naming the field,
        which the create route maps to a 400.

        CREATE only. The poller re-saves a row every tick, and a rule added to
        the spec after the row was minted must not turn that re-save into an
        exception nobody is there to read — the sync's own health verdict is
        where an existing source reports a config it cannot use.
        """
        if self.exist_in_db or not isinstance(self.config, dict) or spec is None:
            return
        for name, field in (spec.config or {}).items():
            value = self.config.get(name)
            blank = value is None or (isinstance(value, str) and not value.strip()) or value in ([], {})
            if blank:
                if field.required and field.default is None:
                    raise ValueError(f"config.{name} is required")
                continue
            if not field.pattern:
                continue
            # One regex per value, so a multi-line field names the entries at
            # fault (the form's rule, `source-form.ts`); `search`, as its
            # `RegExp.test` is.
            try:
                regex = re.compile(field.pattern)
            except re.error:
                continue  # the spec's fault, not the caller's; the form still applies it
            values = value if isinstance(value, list) else [value]
            bad = [str(v) for v in values if isinstance(v, str) and regex.search(v) is None]
            if bad:
                raise ValueError(f"config.{name} is not valid: {', '.join(bad)}")

    def _coerce_reflect(self, spec) -> None:
        """``reflect`` must be a mode the spec offers, or the source ingests
        nothing: the folder driver returns file refs, and with the row-level
        default ``record`` there is no reflector to place them — the poll
        parks on ``reflect_mode`` (``sync.py``) rather than silently dropping
        them, but the API caller who never sent ``reflect`` did not ask for a
        parked source. The dialog can only pick from the spec's list; this
        applies the same list to the API and an agent, and picks the head
        (the spec's declared default) when the value is not on it.

        Looked up at CREATE, plus on a tree-backed driver still sitting on
        ``record`` — that is the one combination that cannot be right, so a
        row minted before this rule heals on its next save, while a correct
        source never pays a spec read on the poller's per-tick re-save.
        """
        driver = self._driver()
        stuck = self.reflect in ("", ReflectMode.RECORD.value) and driver is not None and driver.origin_for is not None
        if self.exist_in_db and not stuck:
            return
        modes = list(getattr(spec, "reflect", None) or []) if spec is not None else []
        if not modes or self.reflect in modes:
            return
        logger.warning(
            "[data_source] %s: reflect=%r is not offered by the %r spec (%s); using %r",
            self.id, self.reflect, self.provider, ", ".join(modes), modes[0],
        )
        self.reflect = modes[0]

    def _stamp_origin(self) -> None:
        """``origin`` follows ``config`` on every save — the driver derives it
        (`origin_for`), pure path arithmetic; a driver with no tree leaves it
        unset, and an unknown provider changes nothing."""
        driver = self._driver()
        if driver is None or driver.origin_for is None:
            return
        try:
            self.origin = driver.origin_for(self)
        except Exception:  # noqa: BLE001 — a bad root is the driver's verify verdict, not a save failure
            logger.debug("[data_source] origin_for failed for %s", self.id, exc_info=True)

    @core_action.post(action_name="choices")
    async def choices_action(cls) -> ApiResponse:
        """POST /api/v1/graph/data_source/choices — the picker's data.

        Body: ``{"provider": str, "field": str, "config": dict}``, read off the request
        context rather than a declared parameter — the dispatcher resolves an annotated
        `request` by identity, and this module's postponed annotations make that a
        string, so a declared one would 400 on every call while direct-call tests passed.
        Class-level, with no entity id, because the picker's whole job is to fill a form
        for a source that does not exist yet.

        POST rather than GET though it reads nothing: the in-progress config travels with
        the call, and a draft config is exactly where a secret lives — ``telegram``'s
        ``bot_token`` is a config field. That must never reach a URL or an access log.
        """
        request_info = get_current_request_info()
        body = (await request_info.get_post_data() if request_info else {}) or {}
        provider = str(body.get("provider") or "").strip()
        field = str(body.get("field") or "").strip()
        if not provider or not field:
            return ApiFailResponse(message="provider and field are required")
        picks = await cls.choices_for(provider, field, body.get("config") or {})
        if picks is None:
            return ApiFailResponse(
                message=f"{provider!r} has no config field {field!r} that offers choices"
            )
        return ApiSuccessResponse(data=picks)

    @classmethod
    async def choices_for(cls, provider: str, field: str, config: Optional[dict] = None):
        """What *provider* can offer for its *field* — a ``ChoiceSet``, or ``None``.

        ``None`` means the question itself was wrong: no such provider, or a field its
        manifest never marked ``choices``. The form only asks about fields the manifest
        marked, so that is a caller bug and says so loudly; answering with an empty list
        would bury it as "nothing to pick".

        Everything a USER can hit answers with a ChoiceSet instead — an empty ``items``
        and one sentence — because every one of those failures means the same thing to
        the person filling the form: type it instead. That is why this catches
        ``SourceError`` centrally rather than asking each driver to.
        """
        from flow_sdk.builtin.data_source_spec import DataSourceSpec  # noqa: PLC0415
        from flow_sdk.ingest.driver import get_driver  # noqa: PLC0415
        from flow_sdk.ingest.health import SourceError  # noqa: PLC0415
        from flow_sdk.schema.data_spec.choice_spec import ChoiceSet  # noqa: PLC0415

        spec = await DataSourceSpec.get_one({"name": provider})
        field_spec = (spec.config or {}).get(field) if spec is not None else None
        if field_spec is None or not field_spec.choices:
            return None

        driver = get_driver(provider)
        if driver is None or driver.choices is None:
            # The shipped-manifest test catches this pairing at CI. At runtime — a spec
            # authored outside this repo — it still must not be a dead end.
            logger.warning("[ingest] %s declares choices on %r but its driver offers none", provider, field)
            return ChoiceSet(detail="This provider can't list options here — type the value directly.")

        draft = cls(provider=provider, config=spec.coerce_config(dict(config or {})))
        try:
            return ChoiceSet(items=await driver.choices(draft, field))
        except SourceError as exc:
            return ChoiceSet(detail=str(exc))
        except Exception as exc:  # noqa: BLE001 — a driver must not 500 the picker
            logger.warning("choices failed for %s.%s: %s", provider, field, exc, exc_info=True)
            return ChoiceSet(detail=f"could not list: {exc}")

    @core_action.post(action_name="verify")
    async def verify_action(self) -> ApiResponse:
        """POST /api/v1/graph/data_source/{id}/verify — the route over ``verify``.

        Thin on purpose, the way ``replay_action`` is thin over ``replay``: the
        verb belongs to the source, and a caller in-process should not have to
        reach through an HTTP handler — or unwrap an ``ApiResponse`` — to use it.
        """
        verdict = await self.verify()
        if verdict is None:
            return ApiFailResponse(message=f"no driver registered for {self.provider!r}")
        return ApiSuccessResponse(data=verdict)

    async def verify(self) -> Optional[dict]:
        """Is this source's setup finished? ``None`` when no driver is registered.

        Two layers, in this order, because they fail for different reasons and
        the fix is different:

        1. **The connection.** The standard OAuth probe — a real call to the
           provider with the stored token. A dead or revoked token has to be
           reported as that, not as "the bot is not in your channels".
        2. **The setup.** The driver's own check. For Slack that is per-channel
           readability, and every configured channel must pass: a source that
           silently ingests three of five channels looks like it is working.

        Moves the source to ACTIVE only when both pass. Nothing here polls or
        waits — it is one round trip per layer.
        """
        driver = self._driver()
        if driver is None:
            return None

        connection = await self._verify_connection()
        if connection is not None:
            self.status = SourceStatus.SETUP.value
            self.setup_detail = connection
            self.verified_at = datetime.now(timezone.utc)
            await self.save()
            return {
                "ready": False, "layer": "connection", "detail": connection,
                "status": self.status,
            }

        verdict = await self._verify_setup(driver)
        self.verified_at = datetime.now(timezone.utc)
        if verdict.ready:
            self.status = SourceStatus.ACTIVE.value
            self.setup_detail = ""
            # Due on the next tick rather than after a full interval: the user
            # just finished setting it up and is watching.
            self.next_poll_at = None
        else:
            self.status = SourceStatus.SETUP.value
            self.setup_detail = verdict.detail
        await self.save()
        return {
            "ready": verdict.ready,
            "layer": "setup",
            "detail": verdict.detail,
            "pending": list(verdict.pending),
            "status": self.status,
        }

    async def sync(self, *, budget: int = 0):
        """Run one sync cycle now, returning an ``IngestReport``.

        Never raises — a failure is recorded as health, not thrown.

        The verb belongs here; ``ingest.sync.sync_source`` stays the function the
        POLLER calls, because it takes a budget and a clock the caller owns.
        Do not confuse this with ``poll_now``, which only marks the source due.
        """
        from flow_sdk.ingest.sync import DEFAULT_SEGMENT_BUDGET, sync_source  # noqa: PLC0415

        return await sync_source(self, budget=budget or DEFAULT_SEGMENT_BUDGET)

    def _driver(self):
        from flow_sdk.ingest.driver import get_driver  # noqa: PLC0415

        return get_driver(self.provider)

    async def _verify_connection(self) -> Optional[str]:
        """None when the token works; otherwise why it does not.

        Uses the same probe the Connections "Test" button runs, so the two can
        never disagree about whether a provider is reachable.
        """
        if not self.channel:
            return None  # nothing to probe against yet
        from flow_sdk.core.oauth.provider_probe import get_probe  # noqa: PLC0415

        if get_probe(self.channel) is None:
            return None  # no probe defined — not a failure, just unverifiable
        from flow_sdk.app.actions.oauth_action import _handle_test  # noqa: PLC0415

        result = await _handle_test(self.channel)
        data = getattr(result, "data", None) or {}
        if data.get("ok") is False:
            return str(data.get("detail") or "the stored credential was refused")
        return None

    async def _verify_setup(self, driver) -> "SetupVerdict":
        from flow_sdk.ingest.driver import SetupVerdict  # noqa: PLC0415

        check = driver.verify
        if check is None:
            # A driver with no setup step is ready as soon as it is configured.
            return SetupVerdict.ok()
        try:
            return await check(self)
        except Exception as exc:  # noqa: BLE001 — a driver must not 500 the button
            logger.warning("verify failed for %s: %s", self.id, exc, exc_info=True)
            return SetupVerdict.waiting(f"could not verify: {exc}")

    async def delete(self):
        """The verb in-process callers actually use."""
        await self.delete_children_of(self.id)
        await super().delete()

    async def destroy(self) -> None:
        """Routes through the fs-record, so it does not pass through `delete`."""
        await self.delete_children_of(self.id)
        await super().destroy()

    # ── shared bodies — the actions above are thin wrappers over these ────────

    async def _make_due(self) -> None:
        """Make this source due on the next tick, clearing any error latch.

        THE un-latch, and it has to cover BOTH latches: `is_due` refuses a
        `config_error` source, and `_round_robin` skips a `config_error`
        cursor. Clearing only the row would let an operator fix a credential,
        press Sync now, and watch the segment sit out every tick while the
        roll-up re-stamps the source from it. One copy, because a second one
        diverges — the rule `SourceError.for_status` states in
        `ingest/health.py`.
        """
        from flow_sdk.builtin.data_source_cursor import DataSourceCursor  # noqa: PLC0415

        self.next_poll_at = None
        if self.health == SourceHealth.CONFIG_ERROR.value:
            self.health = SourceHealth.NEVER_SYNCED.value if self.last_synced_at is None \
                else SourceHealth.OK.value
        self.error_code = None
        self.error_detail = None
        for cursor in await DataSourceCursor.get_all({"data_source_id": self.id}):
            if cursor.health == SourceHealth.CONFIG_ERROR.value:
                cursor.mark_ok()
                cursor.error_code = None
                cursor.error_detail = None
                cursor.consecutive_failures = 0
                await cursor.save()

    async def _reset_cursors(self) -> int:
        """Forget every segment's position; the cursor rows stay (see ``DataSourceCursor.reset_for``)."""
        from flow_sdk.builtin.data_source_cursor import DataSourceCursor  # noqa: PLC0415

        return await DataSourceCursor.reset_for(self.id)
