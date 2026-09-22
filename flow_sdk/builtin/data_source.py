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
import shutil
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone
from math import ceil
from pathlib import Path
from typing import TYPE_CHECKING, ClassVar, Optional

from pydantic import model_validator

from flow_sdk._compat import StrEnum
from flow_sdk.api.api_types.api_field import APIField, Persist, Sharing, persist_policy
from flow_sdk.builtin.source_item import MessageSpec
from flow_sdk.core import Entity
from flow_sdk.core import action as core_action
from flow_sdk.core.entity.entity_model import _SUPPRESS_STORE
from flow_sdk.core.named_lookup import NameAmbiguous, NameNotFound
from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp
from flow_sdk.fs_store.origin.field import OriginField
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.ingest.driver_runtime import SendOutcome
from flow_sdk.ingest.health import SourceHealth
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse
from flow_sdk.schema.data_spec.data_driver_spec import ReflectMode
from flow_sdk.schema.data_spec.source_item_spec import SourceItemSpec
from flow_sdk.schema.types import EntityType
from flow_sdk.secrets.store import SecretStoreRef
from flow_sdk.utils.serialization import iso_to_utc

if TYPE_CHECKING:
    from flow_sdk.connections import ConnectionRequirements
    from flow_sdk.secrets.requirements import SecretRequirements

logger = logging.getLogger(__name__)

#: The heartbeat ticks once a minute, and every provider floor we care about is
#: at least that. A source may ask for less frequent polling, never more.
MIN_POLL_INTERVAL_SECONDS = 60


class DataSourceNotFound(NameNotFound):
    """No data source has that name."""

    message = "no data source named {name!r}"


class DataSourceAmbiguous(NameAmbiguous):
    """Several data source instances share the name; ``candidates`` are their typeids."""

    plural = "data sources"


def _outcome_dict(outcome: SendOutcome) -> dict:
    """A send outcome on the wire: the id the channel assigned, whether it was only drafted, and
    whether the local copy was recorded (a SENT but unrecorded message must never be re-sent)."""
    return {
        "external_id": outcome.external_id,
        "status": str(outcome.status),
        "recorded": outcome.recorded,
        "artifact_id": outcome.artifact_id,
    }


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


#: What a data source that arrived as a file waits for.
#: Set by ``save_runtime``: the one suppressed save whose runtime fields are the news.
_RUNTIME_WRITE: "ContextVar[bool]" = ContextVar("_data_source_runtime_write", default=False)
RECEIVED_SETUP_DETAIL = "Received — connect your own account, then press Verify."


class DataSource(Entity):
    type: str = APIField(default=EntityType.DATA_SOURCE.value)

    # A file asset, so it OWNS its path: ``<scope>/agentic-assets/data_source/<name>/``. Declaring it is
    # what enrolls the class in ``Entity.asset_owner_classes()``. PRIVATE: the path is this machine's.
    asset_ref: Optional[str] = APIField(None, sharing=Sharing.PRIVATE)

    # ── identity / ontology ──
    name: str = APIField(default="")
    kind: str = APIField(default="", description="Ontology kind, e.g. datasource.feed.rss", persist=Persist.FALSE)
    provider: str = APIField(default="", description="Driver registry key: rss | hackernews")
    account_key: str = APIField(default="", description="The remote account/feed-set identity", persist=Persist.FALSE)
    # The user-facing CHANNEL — gmail | slack | jira. Deliberately NOT
    # `provider`, which is the driver/transport key and is literally "agent"
    # for the harness-backed sources. One channel may have several transports
    # (a harness Gmail source and an API one), and threading + the message
    # badge must key on the channel so both resolve to the same thread.
    channel: str = APIField(default="", description="User-facing channel: gmail | slack | jira", persist=Persist.FALSE)
    # The addresses/handles that are ME on this source. A record authored by
    # one of them is mine, and the stream inbox projection must attribute it to the
    # local user — otherwise my own Sent mail counts as unread mail from a
    # stranger, because both unread formulas gate on the sender.
    #
    # A list, not a single value: one mailbox commonly answers to several
    # addresses (aliases, a group address, plus-addressing). Separate from
    # `account_key`, which names the remote account this source serves. That is
    # descriptive only — ids are uuid4 and several sources may serve one
    # account, so nothing dedupes on it and correcting it is a plain edit.
    account_identities: list[str] = APIField(
        default_factory=list, description="Addresses that identify the local user on this source", persist=Persist.FALSE,
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
    origin: OriginField = APIField(default=None, sharing=Sharing.PRIVATE, persist=Persist.FALSE)

    # ── ownership ──
    #
    # Whose source this is: the local user's, or an Agent's. A message source
    # projects into ITS OWNER'S stream inbox and speaks with its owner's voice, so the
    # owner is a key the stream inbox engine reads — which is why it is a field and
    # not `config["agent_id"]`, the provider-opaque bag the engine promises not
    # to open (the same argument that pulled `reflect` out of it, below).
    # `None` on rows written before the field existed; `stream_inbox.projection.owner_of`
    # is the ONE reader and resolves those (config.agent_id → that agent, else
    # the local user), so nothing depends on a backfill having run. PRIVATE: an
    # owner is a fact about this machine, never a thing that travels.
    owner: Optional[TypeId] = APIField(default=None, sharing=Sharing.PRIVATE)
    #: The one place (a Deployment id) that answers this source for its owning agent.
    #: A fact of the SOURCE — it is in ``data_source.json`` — so every machine that
    #: holds the file agrees which of them answers (``agent_serve.answers_here``).
    #: Unset: every place holding it answers, as before places existed.
    answer_place: Optional[str] = APIField(default=None, description="The Deployment that answers this source")

    # The mailbox allowlist, cached for the gate that runs on every inbound
    # message (`AgentMailbox.allowed`). The HUB owns this policy; this is a copy,
    # refreshed on every reconcile, and it is never read to answer "what is the
    # policy" — only to apply it without a network call.
    #
    # Deliberately NOT inside `config`, for the reason the reflection block below
    # gives: `config` is provider-opaque and shareable, and these are third
    # parties' personal addresses. PRIVATE, like `origin`: a fact about this
    # machine that must not travel to a receiver or back to the hub.
    inbound_allowed_senders: list[str] = APIField(default_factory=list, sharing=Sharing.PRIVATE, persist=Persist.FALSE)

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
    status: str = APIField(default=SourceStatus.NEW.value, persist=Persist.FALSE)
    #: What SETUP is waiting for, in the user's words. Empty in every other
    #: state. The card renders this verbatim, so it is a sentence, not a code.
    setup_detail: str = APIField(default="", persist=Persist.FALSE)
    #: When the last verify ran, whatever its verdict.
    verified_at: Optional[datetime] = APIField(default=None, persist=Persist.FALSE)

    # ── sync policy ──
    poll_interval_seconds: int = APIField(default=300, ge=MIN_POLL_INTERVAL_SECONDS)
    window_days: int = APIField(default=7, ge=1, description="The 'since last pull' floor")
    next_poll_at: Optional[datetime] = APIField(default=None, persist=Persist.FALSE)
    last_synced_at: Optional[datetime] = APIField(default=None, persist=Persist.FALSE)

    last_attempted_at: Optional[datetime] = APIField(default=None, persist=Persist.FALSE)

    # ── position: the source's opaque cursor, advanced only after a page is written ──
    cursor: Optional[str] = APIField(default=None, persist=Persist.FALSE)
    #: A reflecting source's diff bookkeeping (path → digest), carried verbatim between passes.
    manifest: dict = APIField(default_factory=dict, persist=Persist.FALSE)
    high_water: Optional[str] = APIField(default=None, persist=Persist.FALSE, description="ISO-8601: the newest record seen")
    consecutive_failures: int = APIField(default=0, persist=Persist.FALSE)

    # ── health of the last pass ──
    health: str = APIField(default=SourceHealth.NEVER_SYNCED.value, persist=Persist.FALSE)
    error_code: Optional[str] = APIField(default=None, persist=Persist.FALSE)
    error_detail: Optional[str] = APIField(default=None, persist=Persist.FALSE)

    # ── what this instance reads with (`set_secret_store` / `set_connection`) ──
    # Saved on the row, not held by the process: the heartbeat's sync, a webhook and an outbound
    # send receive only the row, and must read with what a person bound. Two instances of one
    # source type (two Drives, different folders) each keep their own. PRIVATE: a path, a prefix,
    # an account — facts about this machine.
    #: The store the manifest's names load from; unbound is the default store, then the process
    #: environment.
    secret_store: Optional[SecretStoreRef] = APIField(default=None, sharing=Sharing.PRIVATE)
    #: The provider of the account this source acts as; unbound is the manifest's ``auth.connector``.
    connection: str = APIField(default="", sharing=Sharing.PRIVATE)

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

    # ── the access pattern: declare → get and check → bind ──────────────────
    @classmethod
    async def get(cls, name: str) -> "DataSource":
        """The data source named ``name``. Raises :class:`DataSourceNotFound`, or
        :class:`DataSourceAmbiguous` when several instances share the name."""
        from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415

        rows = await cls.get_all({"name": name})
        if not rows:
            raise DataSourceNotFound(name)
        if len(rows) > 1:
            raise DataSourceAmbiguous(name, [str(row.typeid) for row in rows])
        # An authored source's folder loads on first use; the accessors below read its manifest.
        await DataDriver.get(rows[0].provider or "")
        return rows[0]

    def _auth(self):
        stype = self._driver()
        manifest = getattr(stype, "manifest", None) if stype is not None else None
        return getattr(manifest, "auth", None)

    @property
    def credentials(self) -> "SecretRequirements":
        """The names this source loads from a store — its manifest's ``auth.env``, ``auth.secrets`` keys, or
        the ``auth.vars`` of the credential it reads."""
        from flow_sdk.secrets.requirements import SecretRequirements  # noqa: PLC0415

        auth = self._auth()
        return SecretRequirements((list(auth.env) or list(auth.secrets) or list(auth.vars.values())) if auth is not None else [])

    @property
    def connections(self) -> "ConnectionRequirements":
        """The provider this source acts as, and the scopes it needs — its manifest's ``auth.connector``."""
        from flow_sdk.connections import ConnectionRequirements  # noqa: PLC0415

        auth = self._auth()
        return ConnectionRequirements({auth.connector: auth.scopes} if auth is not None and auth.connector else {})

    async def set_secret_store(self, store) -> None:
        """Bind the store this source loads its names from, and save it; ``None`` unbinds."""
        self.secret_store = store.ref if store is not None else None
        await self.save()

    async def set_connection(self, connection) -> None:
        """Bind the account this source acts as (a ``Connection`` or its provider), and save it;
        ``None`` unbinds. Refuses a provider the source does not declare."""
        self.connection = self.connections.bind(connection, who=self.name or self.provider)
        await self.save()

    async def open(self, *, persona: bool = False):
        """This source for reading, with what is bound loaded in — ``async with await source.open() as live``
        (``live.pages()``, ``live.items(**narrow)``, ``live.source``)."""
        from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415
        from flow_sdk.ingest.session import SourceSession  # noqa: PLC0415

        stype = await DataDriver.get(self.provider or "")
        if stype is None:
            raise LookupError(f"no data source type {self.provider!r}")
        return SourceSession(self, await stype.open(self, persona=persona))

    # ── the asset: where the file lands, and what may touch it ─────────────────
    async def _resolve_scope_project(self):
        """The project whose ``agentic-assets/data_source/`` holds this source.

        A project-scoped request; the row's own project; its owning agent's project; and, for code
        running outside any request (a script, a block), the working directory's project. None lands
        it in the user scope — a mailbox source the heartbeat creates has no project to belong to.
        """
        scoped = await super()._resolve_scope_project()
        if scoped is not None or self.exist_in_db:
            return scoped  # placement happens once, at create; a poll's save never asks again
        from flow_sdk.builtin.project import Project  # noqa: PLC0415
        from flow_sdk.stream_inbox.projection import owning_agent  # noqa: PLC0415

        if getattr(self, "project_id", None):
            return await Project.get_by_id(str(self.project_id))
        agent = await owning_agent(self)
        if agent is not None and getattr(agent, "project_id", None):
            return await Project.get_by_id(str(agent.project_id))
        if get_current_request_info() is None:
            from flow_sdk import context  # noqa: PLC0415

            return await context.current_project()
        return None

    async def save_runtime(self) -> None:
        """Persist what the engine learned while running — never the file.

        The poller holds a row for a whole poll, and a person may edit ``data_source.json`` meanwhile:
        a full save of the stale row would put the old config back. So this re-reads the row, copies
        only ``RUNTIME_FIELDS`` onto it and saves the database row alone.
        """
        if not self.exist_in_db:
            await self.save()
            return
        token, runtime = _SUPPRESS_STORE.set(True), _RUNTIME_WRITE.set(True)
        try:
            fresh = await type(self).get_by_id(str(self.id))
            if fresh is None:
                return
            for name in RUNTIME_FIELDS:
                setattr(fresh, name, getattr(self, name))
            await fresh.save()
        finally:
            _RUNTIME_WRITE.reset(runtime)
            _SUPPRESS_STORE.reset(token)

    async def _refuse_duplicate_account(self) -> None:
        """One source per (driver, account, owner) on this machine: the same mailbox polled twice
        ingests every message twice. The owner stays in the key — a user and an agent may each watch
        the same account."""
        driver = self._driver()
        key = getattr(driver, "identity_config_key", "") if driver is not None else ""
        value = (self.config or {}).get(key) if key else None
        if not isinstance(value, str) or not value.strip():
            return
        existing = await type(self).find_for_account(self.provider, key, value, owner=self.owner)
        if existing is not None and str(existing.id) != str(self.id):
            raise ValueError(f"{value} is already watched by the data source {existing.name or existing.id!s}")

    @classmethod
    async def find_for_account(
        cls, provider: str, key: str, value: str, *, owner: "Optional[TypeId]" = None
    ) -> "Optional[DataSource]":
        """The source of ``provider`` whose ``config[key]`` names ``value``.

        The canonical natural-key lookup (same shape as
        ``SourceItem.find_existing``): callers wanting connect-or-reuse
        semantics ask HERE instead of re-scanning ``get_all`` and filtering by
        hand — the id policy's whole point is that identity is a lookup.
        ``key`` is normally the driver's ``identity_config_key``.

        An empty ``key`` is a driver that names its account itself (a bot's getMe):
        ``value`` then matches the row's ``account_key`` or a discovered identity.

        ``owner`` narrows to that owner's source, so the same account can be
        watched by the local user AND by an Agent without either reusing the
        other's row. Omitted, it is the pre-owner lookup. Resolved through
        ``owner_of`` rather than the column, so a legacy row that only carries
        ``config.agent_id`` still answers.
        """
        from flow_sdk.stream_inbox.projection import owner_of  # noqa: PLC0415

        value = str(value or "").strip()
        for row in await cls.get_all({"provider": provider}):
            candidates = [(row.config or {}).get(key)] if key else [row.account_key, *(row.account_identities or [])]
            if not any(str(c or "").strip() == value for c in candidates):
                continue
            if owner is not None and await owner_of(row) != owner:
                continue
            return row
        return None

    @classmethod
    async def find_owned(cls, owner: "TypeId", *, channel: Optional[str] = None) -> "list[DataSource]":
        """Every source ``owner`` holds — optionally only those on ``channel``.

        The indexed filter first; then the rows written before ``owner`` existed
        (``owner`` absent), which ``owner_of`` resolves the same way every other
        reader does. The two are disjoint, so no row is counted twice.
        """
        from flow_sdk.stream_inbox.projection import owner_of  # noqa: PLC0415

        rows = list(await cls.get_all({"owner": str(owner)}))
        legacy = await cls.get_all(
            QueryFilter(match=ExpressionNode(op=QueryOp.IS_NULL, operands=["owner"]))
        )
        for row in legacy:
            if await owner_of(row) == owner:
                rows.append(row)
        if channel is not None:
            rows = [r for r in rows if (r.channel or "").strip() == channel]
        return rows

    def reply_spec(self, item, *, body: str, attachments=()) -> MessageSpec:
        """The reply to ``item``, in THIS channel's shape.

        The one constructor a caller should reach for, because picking the class
        by hand is picking the addressing rule by hand: ``EmailMessageSpec``
        addresses the author, ``SlackMessageSpec`` addresses the channel, and a
        caller that guesses wrong on a Slack source sends the reply as a DM to
        the person instead of posting it where everyone is reading. The driver
        already knows which rule is its own (``outbound_spec``); ask it.

        Synchronous because every ``reply_to`` is a pure constructor — no I/O,
        so this is safe to call anywhere the item is in hand.
        """
        driver = self._driver()
        if driver is None:
            raise RuntimeError(f"no driver for {self.provider}")
        return driver.outbound_spec(self).reply_to(item, body=body, attachments=attachments)

    async def send(self, spec: MessageSpec) -> SendOutcome:
        """Deliver one outbound message through this source's driver.

        Message-shape validation belongs here rather than on each workflow
        surface: a direct SDK caller and ``blocks.StreamInbox`` must reject the same
        unsupported attachment or recipient shape before provider I/O begins.
        """
        from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415
        from flow_sdk.builtin.source_item import EmailMessageSpec  # noqa: PLC0415

        if spec.attachments:
            raise NotImplementedError(
                "attachments are not supported on this channel yet — "
                "the driver send contract carries text only"
            )
        if len(spec.to) != 1:
            raise ValueError(f"exactly one recipient for now, got {len(spec.to)}")

        driver = DataDriver.loaded(self.provider)
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
        from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415
        from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415
        from flow_sdk.ingest.ingestor import ingest_items  # noqa: PLC0415
        from flow_sdk.ingest.sync import sync_source  # noqa: PLC0415

        expected = _normalize_message_id(sent.external_id)
        if not expected:
            raise ValueError("cannot expect a reply to a send with no external_id")
        driver = DataDriver.loaded(self.provider)

        while True:
            items = await SourceItem.get_all({"data_source_id": self.id})
            for item in items:
                if _normalize_message_id(item.reply_to_external_id) == expected:
                    return SourceItemSpec.model_validate(
                        {key: getattr(item, key) for key in SourceItemSpec.model_fields}
                    )
            if driver is not None and driver.finds_replies:
                reply = await driver.wait_for_reply(self, str(sent.external_id))
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
    #   reset          — forget our position, keep the records
    #   purge_items    — forget the records
    #
    # `reset` ALONE looks broken, and that is not a bug in the action:
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
        await self.save_runtime()
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
            await self.save_runtime()
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

    @core_action.post(action_name="reset")
    async def reset_action(self) -> ApiResponse:
        """POST /api/v1/graph/data_source/{id}/reset — forget position.

        Clears the cursor and the reflection manifest, so the next poll re-reads the whole window.
        """
        await self.reset()
        return ApiSuccessResponse(data={
            "status": "reset",
            "detail": "position cleared; existing records still gate on content digest — "
                      "pair with purge_items for a visible re-fetch",
        })

    async def reset(self) -> None:
        """Forget this source's position and make it due."""
        self._forget_position()
        self.next_poll_at = None
        await self.save_runtime()

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
        body = await self._body()
        raw_since = str(body.get("since") or "").strip()

        since, problem = parse_since(raw_since)
        if problem:
            return ApiFailResponse(message=problem)

        return ApiSuccessResponse(data=await self.replay(since=since))

    async def replay(self, *, since: Optional[datetime] = None) -> dict:
        """The replay body — see ``replay_action`` for what it means and why."""
        removed = await self.purge_records_of(self.id, since=since)
        self._forget_position()

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
            "since": since.isoformat() if since else None,
            "window_days": self.window_days,
            "window_widened": widened,
            "detail": "queued for the next heartbeat tick (≤60s)",
        }

    # ── deletion cascades, on BOTH paths ──────────────────────────────────────
    #
    # Nothing cascades on its own: the records (only ``purge_items``
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
            # The stream inbox side of the purge. Under the reference model the
            # projected FlowMessages hold no body of their own — leaving them
            # behind would fill the stream inbox with blank rows, so the cascade is
            # mandatory, not hygiene.
            from flow_sdk.stream_inbox.projection import remove_projection_for_items  # noqa: PLC0415

            await remove_projection_for_items([i.id for i in doomed])
        return len(doomed)

    @classmethod
    async def delete_children_of(cls, source_id: str) -> None:
        """Every row keyed to this source — the records and the consumer positions."""
        from flow_sdk.builtin.consumer_position import ConsumerPosition  # noqa: PLC0415
        from flow_sdk.builtin.source_change import SourceChange  # noqa: PLC0415

        await cls.purge_records_of(source_id)
        await ConsumerPosition.delete_for(source_id)
        await SourceChange.delete_for(source_id)

    @classmethod
    async def delete_by_id(cls, eid: str):
        """The path `DELETE /api/v1/graph/data_source/{id}` takes."""
        row = await cls.get_by_id(str(eid))
        await cls.delete_children_of(str(eid))
        result = await super().delete_by_id(eid)
        remove_source_folder(getattr(row, "asset_ref", None))
        return result

    async def save(self, *args, **kwargs):
        """Resolve NEW on the way in, so a source is never stuck un-runnable.

        NEW is transient by design: it means "nobody has decided yet". The
        decision is the driver's — one that declares `verify` has a setup step a
        human must complete (Slack's bot invite), so it starts in SETUP; one that
        does not is ready the moment it is configured, so it starts ACTIVE. That
        keeps a plain RSS feed from demanding a Verify click it has no use for.

        Also stamps ``owner`` on the way in when nothing set it: the local user,
        or the agent a legacy ``config.agent_id`` names. One choke-point rather
        than one per constructor, so the UI create path and every block get it
        without knowing it exists.
        """
        if self.owner is None:
            from flow_sdk.stream_inbox.projection import owner_of  # noqa: PLC0415

            self.owner = await owner_of(self)
        if _SUPPRESS_STORE.get():
            # A row written WITHOUT writing its file: the indexer reading a data_source.json, a share
            # being received, or ``save_runtime``. A file that arrived (cloned, shared, copied) names
            # someone's account — it waits for this machine's own connection before it polls. A file
            # holds no status, so whatever a first read carries (the indexer stamps ``active``) is not a decision.
            if not self.exist_in_db:
                self.status = SourceStatus.SETUP.value
                self.setup_detail = RECEIVED_SETUP_DETAIL
            elif not _RUNTIME_WRITE.get():
                # A re-read file carries no runtime facts, only the indexer's defaults: keep the row's.
                stored = await type(self).get_by_id(str(self.id))
                for name in RUNTIME_FIELDS if stored is not None else ():
                    setattr(self, name, getattr(stored, name))
            return await super().save(*args, **kwargs)
        if not self.exist_in_db:
            await self._refuse_duplicate_account()
        if not self.exist_in_db or self.status == SourceStatus.NEW.value:
            # An authored source's folder loads on first use, so the create rules below can ask its
            # class. The poller's per-tick re-save of an existing row never pays for the lookup.
            from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415

            await DataDriver.get(self.provider or "")
        if self.status == SourceStatus.NEW.value:
            stype = self._driver()
            if stype is not None and stype.has_setup:
                self.status = SourceStatus.SETUP.value
                if not self.setup_detail:
                    self.setup_detail = "Finish setup, then press Verify."
            else:
                # Includes an UNKNOWN provider, deliberately: leaving it in NEW
                # would park it silently, while ACTIVE lets the poller reach
                # `sync_source`, which reports `unknown_provider` as a
                # config_error the card can actually explain.
                self.status = SourceStatus.ACTIVE.value
        driver = self._driver()
        if driver is not None and driver.config_cls is not None:
            self._type_config(driver.config_cls)
        # The reflect rule reads the driver's row; `_needs_spec` keeps the poller's per-tick re-save free of it.
        self._coerce_reflect(await self._spec() if self._needs_spec() else None)
        if not (self.channel or "").strip():
            # Stamp the channel at CREATE, not first poll: the credential probe keys on it (Verify on
            # a fresh source probed nothing) and the UI badges by it. `sync_source` keeps re-stamping
            # every poll; a type that answers empty (a file source, an agent transport with no
            # connector yet) stamps nothing here.
            stype = self._driver()
            if stype is not None:
                try:
                    stamped = str(stype.channel_for(self) or "").strip()
                except Exception:  # noqa: BLE001 — a probe must never fail a save
                    stamped = ""
                if stamped:
                    self.channel = stamped
        self._stamp_origin()
        return await super().save(*args, **kwargs)

    def _needs_spec(self) -> bool:
        """True when any save-time rule below still has a question for the spec.

        A saved row whose reflect mode is settled has nothing to ask, which is
        the poller's case on every tick.
        """
        driver = self._driver()
        stuck = self.reflect in ("", ReflectMode.RECORD.value) and driver is not None and driver.reflects
        return stuck or not self.exist_in_db

    async def _spec(self) -> "Optional[object]":
        """The provider's definition row, or None when it cannot be resolved —
        an unresolvable spec changes nothing about any of the three rules."""
        from flow_sdk.builtin.data_driver import DataDriver

        try:
            return await DataDriver.get_one({"name": self.provider})
        except Exception:  # noqa: BLE001 — an unresolvable spec changes nothing
            return None

    def _type_config(self, config_cls) -> None:
        """The driver's ``Config`` applied on save. A create is validated whole — a field it lacks or
        a value off its rule is a ``ValueError`` naming it, which the create route maps to a 400. An
        existing row only has what it typed shaped (a string where a list is declared); a rule added
        later must not turn the poller's re-save into an exception nobody reads."""
        if not isinstance(self.config, dict):
            return
        if "agent_id" in self.config and "agent_id" not in config_cls.model_fields:
            # The legacy spelling of the owner, already read into ``owner`` above; not this driver's config.
            self.config = {k: v for k, v in self.config.items() if k != "agent_id"}
        if self.exist_in_db:
            if any(isinstance(v, str) for v in self.config.values()):
                self.config = {**self.config, **config_cls.draft(self.config)}
            return
        self.config = config_cls.validated(self.config).model_dump(mode="json", exclude_unset=True)

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
        stuck = self.reflect in ("", ReflectMode.RECORD.value) and driver is not None and driver.reflects
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
        if driver is None or not driver.reflects:
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
        body = await cls._body()
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
        from flow_sdk.builtin.data_driver import DataDriver
        from flow_sdk.ingest.health import SourceError  # noqa: PLC0415
        from flow_sdk.schema.data_spec.choice_spec import ChoiceSet  # noqa: PLC0415
        from flow_sdk.sources import errors as contract  # noqa: PLC0415

        spec = await DataDriver.get_one({"name": provider})
        field_spec = (spec.config or {}).get(field) if spec is not None else None
        if field_spec is None or not field_spec.choices:
            return None

        stype = DataDriver.loaded(provider)
        if stype is None or not stype.offers_choices:
            # The shipped-manifest test catches this pairing at CI. At runtime — a spec
            # authored outside this repo — it still must not be a dead end.
            logger.warning("[ingest] %s declares choices on %r but its driver offers none", provider, field)
            return ChoiceSet(detail="This provider can't list options here — type the value directly.")

        draft = cls(provider=provider, config=stype.coerce_config(dict(config or {})))
        try:
            return ChoiceSet(items=await stype.choices(draft, field))
        except contract.SourceError as exc:
            return ChoiceSet(detail=str(exc))
        except SourceError as exc:
            # `detail`, not `str(exc)`: the latter prefixes the machine code
            # ("no_project: Set 'GCP project'…"), and this sentence is rendered verbatim
            # under the field for a person to act on.
            return ChoiceSet(detail=exc.detail or str(exc))
        except Exception as exc:  # noqa: BLE001 — a driver must not 500 the picker
            logger.warning("choices failed for %s.%s: %s", provider, field, exc, exc_info=True)
            return ChoiceSet(detail=f"could not list: {exc}")

    # ── the verbs the CLI, the TS SDK and the UI share ────────────────────────
    # Thin routes over real verbs, the `replay`/`replay_action` shape: bodies come from the request
    # info (see `replay_action` on why an action declares no parameters).

    @staticmethod
    async def _body() -> dict:
        request_info = get_current_request_info()
        return dict(await request_info.get_post_data() or {}) if request_info else {}

    @core_action.post(action_name="send")
    async def send_action(self) -> ApiResponse:
        """POST /api/v1/graph/data_source/{id}/send — one message into the channel.

        Body: ``{"to", "text", "thread_key"?, "subject"?, "in_reply_to"?}``. ``to`` is what the channel
        addresses (a chat, a channel id, an address); the source class reads it (``message_for``)."""
        body = await self._body()
        try:
            return ApiSuccessResponse(data=await self.send_text(
                to=str(body.get("to") or ""), text=str(body.get("text") or ""), thread_key=str(body.get("thread_key") or ""),
                subject=str(body.get("subject") or ""), in_reply_to=str(body.get("in_reply_to") or ""),
            ))
        except (ValueError, RuntimeError, NotImplementedError) as exc:
            return ApiFailResponse(message=str(exc))

    async def send_text(self, *, to: str, text: str, thread_key: str = "", subject: str = "", in_reply_to: str = "") -> dict:
        from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415

        driver = await DataDriver.get(self.provider or "")
        if driver is None or not driver.sends:
            raise RuntimeError(f"{self.provider} cannot send")
        if not (text or "").strip():
            raise ValueError("text is required")
        outcome = await driver.send(self, thread_key=thread_key, to=to, text=text, subject=subject, in_reply_to=in_reply_to)
        return _outcome_dict(outcome)

    @core_action.post(action_name="reply")
    async def reply_action(self) -> ApiResponse:
        """POST /api/v1/graph/data_source/{id}/reply — answer one of this source's items.

        Body: ``{"item_id", "text"}``. Who the reply goes to is the channel's rule (``reply_spec``)."""
        body = await self._body()
        try:
            return ApiSuccessResponse(data=await self.reply_to_item(str(body.get("item_id") or ""), str(body.get("text") or "")))
        except LookupError as exc:
            return ApiFailResponse(message=str(exc), status_code=404)
        except (ValueError, RuntimeError, NotImplementedError) as exc:
            return ApiFailResponse(message=str(exc))

    async def reply_to_item(self, item_id: str, text: str) -> dict:
        from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415

        item = await SourceItem.get_one({"id": item_id, "data_source_id": self.id}) if item_id else None
        if item is None:
            raise LookupError(f"no item {item_id!r} on this source")
        if not (text or "").strip():
            raise ValueError("text is required")
        return _outcome_dict(await self.send(self.reply_spec(item, body=text)))

    @core_action.post(action_name="items")
    async def items_action(self) -> ApiResponse:
        """POST /api/v1/graph/data_source/{id}/items — this source's records, newest first.

        Body: ``{"limit"?}`` (default 20)."""
        body = await self._body()
        return ApiSuccessResponse(data={"items": await self.recent_items(int(body.get("limit") or 20))})

    async def recent_items(self, limit: int = 20) -> list[dict]:
        from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415
        from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415

        rows = await SourceItem.get_all(QueryFilter(
            match=ExpressionNode(op=QueryOp.EQ, operands=["data_source_id", str(self.id)]),
            order_by=[{"occurred_at": "desc"}, {"created_date": "desc"}],
            limit=max(limit, 0),
        )) or []
        fields = ("id", "external_id", "kind", "name", "thread_key", "author_external_id", "author_display", "occurred_at")
        return [{**{f: getattr(r, f, None) for f in fields}, "body": str(getattr(r, "body", "") or "")[:500]} for r in rows]

    @core_action.post(action_name="sync")
    async def sync_action(self) -> ApiResponse:
        """POST /api/v1/graph/data_source/{id}/sync — one sync cycle NOW, reported. Unlike ``poll_now``
        this waits for the cycle: it is what a person or an agent runs to see a source work. Like
        ``poll_now`` it un-latches ``config_error`` first: someone asking for a sync after fixing a
        credential means to try again."""
        await self._make_due()
        await self.save_runtime()
        report = await self.sync()
        # The cycle writes health through its own row handle; read what it left.
        refreshed = await type(self).get_one({"id": self.id}) or self
        return ApiSuccessResponse(data={
            "created": report.created, "updated": report.updated, "unchanged": report.unchanged,
            "health": refreshed.health, "status": refreshed.status, "error_detail": refreshed.error_detail,
        })

    @core_action.post(action_name="set_enabled")
    async def set_enabled_action(self) -> ApiResponse:
        """POST /api/v1/graph/data_source/{id}/set_enabled — ``{"enabled": bool}``. Disabled stops polling."""
        enabled = bool((await self._body()).get("enabled", True))
        self.status = SourceStatus.ACTIVE.value if enabled else SourceStatus.DISABLED.value
        await self.save_runtime()
        return ApiSuccessResponse(data={"status": self.status})

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
            await self.save_runtime()
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
        await self.save_runtime()
        return {
            "ready": verdict.ready,
            "layer": "setup",
            "detail": verdict.detail,
            "pending": list(verdict.pending),
            "status": self.status,
        }

    async def sync(self):
        """Run one sync cycle now, returning an ``IngestReport``.

        Never raises — a failure is recorded as health, not thrown.

        Do not confuse this with ``poll_now``, which only marks the source due.
        """
        from flow_sdk.ingest.sync import sync_source  # noqa: PLC0415

        return await sync_source(self)

    def _driver(self):
        from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415

        return DataDriver.loaded(self.provider)

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

    async def _verify_setup(self, stype):
        """The type's setup verdict; a source that raises becomes a verdict, never a 500."""
        from flow_sdk.sources.protocols import Verdict  # noqa: PLC0415

        try:
            return await stype.verify(self)
        except Exception as exc:  # noqa: BLE001 — a source must not 500 the button
            logger.warning("verify failed for %s: %s", self.id, exc, exc_info=True)
            return Verdict(ready=False, detail=f"could not verify: {exc}")

    async def delete(self):
        """The verb in-process callers actually use."""
        await self.delete_children_of(self.id)
        await super().delete()
        remove_source_folder(self.asset_ref)

    # ── shared bodies — the actions above are thin wrappers over these ────────

    async def _make_due(self) -> None:
        """Make this source due on the next tick, clearing the ``config_error`` latch ``is_due`` refuses."""
        self.next_poll_at = None
        if self.health == SourceHealth.CONFIG_ERROR.value:
            self.health = SourceHealth.NEVER_SYNCED.value if self.last_synced_at is None \
                else SourceHealth.OK.value
            self.consecutive_failures = 0
        self.error_code = None
        self.error_detail = None

    def _forget_position(self) -> None:
        self.cursor = None
        self.manifest = {}
        self.high_water = None


#: What the engine writes while a source runs: never in ``data_source.json``, only on the row
#: (``save_runtime``). Everything else on the row is authored and lives in the file.
RUNTIME_FIELDS: tuple[str, ...] = tuple(
    name for name, field in DataSource.model_fields.items()
    if name in DataSource.__annotations__  # this type's own, not the Entity base's
    and persist_policy(field) == Persist.FALSE
)


def remove_source_folder(asset_ref: Optional[str]) -> None:
    """Delete a removed source's folder; left behind, the next index brings the source back. Only a
    writable folder holding this type's main document — never a shipped one, never anything else."""
    from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415
    from flow_sdk.fs_store.path_utils import is_protected_path  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    folder = Path(asset_ref) if asset_ref else None
    main = SchemaRegistry.get(EntityType.DATA_SOURCE.value).shape.main
    if folder is None or not (folder / main).is_file() or is_protected_path(folder):
        return
    if Entity._scope_from_path(str(folder)) == "system":
        return
    shutil.rmtree(folder, ignore_errors=True)


async def migrate_list_configs() -> int:
    """Split every source whose config still lists N containers into one source per entry. One time:
    a source reads one stream now. The original goes, with what it ingested; each new source re-reads
    its window. A driver names its retired list key (``Config.retired_list``); a config that cannot
    split stays, and its missing single field parks it with ``config.<field> is required``.
    Returns how many sources were split."""
    from flow_sdk.ingest.driver_runtime import DRIVERS  # noqa: PLC0415
    from flow_sdk.schema.data_spec.data_source_spec import DataSourceSpec  # noqa: PLC0415

    split = 0
    retiring = [driver for _, driver in DRIVERS.items() if driver.config_cls is not None and driver.config_cls.retired_list]
    rows = [(driver, row) for driver in retiring for row in await DataSource.get_all({"provider": driver.provider})]
    for driver, row in rows:
        parts = driver.config_cls.split(row.config or {})
        if not parts:
            continue
        if len(parts) == 1:  # one entry: the same source, under the single key
            row.config = parts[0][1]
            await row.save()
            split += 1
            continue
        authored = {
            name: getattr(row, name) for name in DataSourceSpec.model_fields
            if name not in ("name", "provider", "config") and getattr(row, name, None) is not None
        }
        try:
            for label, config in parts:
                await driver.create_source(
                    config, name=f"{row.name} {label}".strip(), project_id=row.project_id, scope=row.scope,
                    account_key=row.account_key, **authored,
                ).save()
        except Exception:  # noqa: BLE001 — the fallback is the park, never a failed boot
            logger.warning("could not split data source %s", row.id, exc_info=True)
            continue
        await row.delete()
        split += 1
    return split


async def prune_fileless_data_sources() -> int:
    """Remove every configured source that has no ``data_source.json``, with what it ingested.

    A data source is an asset: the file is the truth and the row is its index. Rows written before
    sources were files have no file to be re-indexed from, so they go — through the cascade, so no
    record, cursor or projected message is left pointing at a source that is gone. Also takes rows a
    development build wrote under ``data_driver``, the type string the definition now owns.
    Idempotent: after the first run every row has a file and this reads a handful of rows.
    """
    from flow_sdk.db import get_db_driver  # noqa: PLC0415
    from flow_sdk.fs_store.orphan_removal import remove_orphan_row  # noqa: PLC0415

    no_file = ExpressionNode(op=QueryOp.IS_NULL, operands=["asset_ref"])
    removed = 0
    for type_name in (EntityType.DATA_SOURCE.value, "data_driver"):
        for record in await get_db_driver().get_all(QueryFilter(type=type_name, match=no_file)):
            if type_name != EntityType.DATA_SOURCE.value:  # a data_source row's cascade is its type's orphan hook
                await DataSource.delete_children_of(str(record.id))
            removed += bool(await remove_orphan_row(str(record.id), type_name))
    return removed