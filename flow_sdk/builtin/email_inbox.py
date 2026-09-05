"""The Agent's mailbox — a functional entity, not a descriptor.

The Hub allocates one mailbox per Agent and owns its formal identity: the
provider, the provider's opaque inbox id, the public address, and the lifecycle
status. This module is the SDK's side of that mailbox, and it owns the *verbs* —
who may drive it, whether it is on, what polls it, how a message is sent.

**A transient projection, not a local row.** Same shape as ``LLMEndpoint``
(``flow_sdk/builtin/llm_endpoint.py``): ``_api_visible`` is False and
``_hub_only`` is True because there is nothing local to serve or to share — an
instance is built from the Hub's descriptor on demand, and :meth:`save` refuses.
Behaviour does not require storage, and a local copy of the Hub's row could only
drift from it.

**Why the verbs live here and not on ``Agent``.** A mailbox's policy is the
mailbox's: ``inbox.allowed(address)`` says what it means, where the old
``agent.may_email(address)`` read as outbound permission and meant the opposite.
An Agent holds an inbox; it is not one. ``Agent`` keeps exactly two things — the
``inbox`` accessor and the one idempotent ``allocate_inbox()`` call.

**Three verbs, and they are genuinely distinct.**

* **allocate** — idempotent (see :meth:`EmailInbox.allocate`). Allocates at the
  Hub *or adopts what is already allocated*, wires the ``cloud_email`` source,
  turns both on. There is no separate "enable": enabling a mailbox you do not
  have and re-enabling one you do are the same request, and one less state for a
  caller to get wrong.
* **disable** — reversible. The address, the Hub row, the source and its cursor
  all survive, so a pause costs no mail. An on/off switch must never release a
  billable public identity as a side effect.
* **release** — terminal. The address is gone and mail to it bounces.

**``allowed`` is pure and synchronous, and that is load-bearing.** It runs on
every inbound message in ``flow_sdk/inbox/agent_runner.py``, so it must never
reach the Hub or the database — which is why :meth:`from_source` exists and why
``allowed_senders`` rides on the projection as a runtime-only field. That is
also what lets its storage move to the Hub later without this file's callers or
their tests changing: only the constructors do.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING, Any, ClassVar, Optional

from pydantic import PrivateAttr

from flow_sdk.api.api_types.api_field import APIField, Persist, Sharing
from flow_sdk.api.api_types.identifier import is_valid_entity_id
from flow_sdk.core import Entity
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.schema.types import EntityType

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.data_source import DataSource

#: The Hub's lifecycle vocabulary. ACTIVE and DISABLED are two states of one
#: allocated address; DELETED is the only retired one.
STATUS_ACTIVE = "active"
STATUS_DISABLED = "disabled"
STATUS_DELETED = "deleted"

#: The identity fields the Hub owns. Named once so the adopter, the parser and
#: the wire view cannot drift apart when the Hub grows a field.
_HUB_FIELDS = ("address", "display_name", "provider", "provider_inbox_id", "status")


async def email_source_for_agent(agent_id: str) -> "Optional[DataSource]":
    """The local ``cloud_email`` source for an agent, inbox or no inbox.

    A module function rather than a method because the two callers that need it
    most — reporting state, and disabling — have to work when there is no
    mailbox at all and therefore no projection to hang it off.
    """
    import flow_sdk.ingest.drivers  # noqa: F401, PLC0415 — register drivers
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415
    from flow_sdk.ingest.drivers.cloud_email import CloudEmailDriver  # noqa: PLC0415

    return await DataSource.find_for_account(
        CloudEmailDriver.provider,
        CloudEmailDriver.identity_config_key,
        str(agent_id or ""),
        owner=TypeId(type=EntityType.AGENT.value, id=str(agent_id or "")),
    )


def _inbox_id_from(config: Mapping[str, Any]) -> str:
    """The inbox id stamped in a source's config, or ``""`` when absent/unparseable."""
    raw = str(config.get("inbox_typeid") or "").strip()
    if not raw:
        return ""
    try:
        return TypeId(raw).id or ""
    except Exception:  # noqa: BLE001 — a malformed stamp is missing, not fatal
        return ""


class EmailInbox(Entity):
    """One Agent's mailbox: Hub-owned identity, SDK-owned behaviour."""

    _api_visible: ClassVar[bool] = False
    _hub_only: ClassVar[bool] = True

    type: str = APIField(default=EntityType.EMAIL_INBOX.value)
    address: str = APIField()
    display_name: str | None = APIField(default=None)
    provider: str = APIField()
    provider_inbox_id: str = APIField()
    status: str = APIField()
    agent_typeid: TypeId = APIField()

    #: Who may drive the Agent through this mailbox. **Empty means nobody** —
    #: closed, not open: the address is public, permanent and publicly writable,
    #: so the default that cannot hand a tool-holding agent to whoever guessed
    #: the address is the safe one.
    #:
    #: The Hub row owns and enforces this; the value here is what its descriptor
    #: carried. ``Persist.FALSE`` because this projection has no row of its own,
    #: and PRIVATE because these are third parties' personal addresses.
    allowed_senders: list[str] = APIField(
        default_factory=list,
        persist=Persist.FALSE,
        sharing=Sharing.PRIVATE,
        description="Addresses allowed to drive the agent through this mailbox; empty allows none.",
    )
    #: Standing read defaults the mailbox carries, in the Hub's wire vocabulary
    #: (``labels`` / ``from`` / ``to`` / ``subject`` / ``before`` / ``after``).
    #: Defaults, not constraints — an explicit parameter always wins.
    filters: dict = APIField(default_factory=dict, persist=Persist.FALSE)
    #: Whether :meth:`allocate` bought this address rather than adopting one that
    #: already existed — a fact about the CALL, not about the mailbox, so it is
    #: runtime-only like ``LLMEndpoint.invocable``. It is what keeps allocate's
    #: idempotence assertable.
    newly_allocated: bool = APIField(default=False, persist=Persist.FALSE)

    #: The Agent this projection was built from, when it was built from one.
    #: Saves a row read on the paths that already hold it.
    _owner: Any = PrivateAttr(default=None)

    def is_file_backed(self) -> bool:
        return False

    async def save(self, *args, **kwargs):  # noqa: D401 — a guard, not a verb
        """Refuse: the Hub's row is the mailbox, and there is no local copy."""
        raise ValueError(
            "an EmailInbox is the hub's row — it has no local copy to save; "
            "use allocate / disable / release / configure"
        )

    # ── identity ──────────────────────────────────────────────────────────

    @property
    def agent_id(self) -> str:
        """The owning Agent's id — what the Hub route is still keyed by."""
        return self.agent_typeid.id if self.agent_typeid else ""

    @property
    def is_active(self) -> bool:
        return self.status == STATUS_ACTIVE

    # ── policy ────────────────────────────────────────────────────────────

    def allowed(self, address: str) -> bool:
        """Whether *address* may drive the Agent through this mailbox.

        Pure and synchronous — the inbound path calls this per message.

        Case- and whitespace-insensitive: an address is an identifier a human
        types, and ``Alice@Example.com `` is the same correspondent as
        ``alice@example.com``. Nothing normalizes on the way in, so it happens
        here — through ``normalize_email``, the funnel every other email
        comparison uses. This gate decides who may drive an agent holding tools,
        so it must keep agreeing with ``is_self_address`` rather than carrying
        its own casefold.

        A mailbox that is not active refuses everyone: the switch is a kill switch
        and must beat a populated list. An empty allowlist admits nobody — see
        :attr:`allowed_senders`.
        """
        from flow_sdk.builtin.user import normalize_email  # noqa: PLC0415

        if not self.is_active:
            return False
        candidate = normalize_email(address)
        if not candidate:
            return False
        return any(candidate == normalize_email(a) for a in self.allowed_senders)

    # ── constructors ──────────────────────────────────────────────────────

    @classmethod
    def from_hub_descriptor(
        cls,
        descriptor: Mapping[str, Any],
        *,
        agent_typeid: TypeId,
        allowed_senders: Sequence[str] = (),
    ) -> "EmailInbox":
        """Adopt and validate the Hub identity carried by an inbox descriptor.

        Policy comes from the descriptor: the Hub row owns the allowlist and the
        read defaults, so what a client shows and what the Hub enforces cannot
        diverge. ``allowed_senders`` remains as a fallback for a Hub too old to
        carry it — never as an override, because a local answer to "who may drive
        this agent" is exactly the second source of truth this removed.
        """
        inbox_typeid = TypeId(str(descriptor.get("typeid") or ""))
        if (
            inbox_typeid.type != EntityType.EMAIL_INBOX.value
            or not inbox_typeid.id
            or not is_valid_entity_id(inbox_typeid.id)
        ):
            raise ValueError(f"Invalid Hub EmailInbox TypeId: {inbox_typeid}")

        linked_agent = TypeId(str(descriptor.get("agent_typeid") or ""))
        if (
            linked_agent.type != EntityType.AGENT.value
            or not linked_agent.id
            or not is_valid_entity_id(linked_agent.id)
            or linked_agent != agent_typeid
        ):
            raise ValueError(f"EmailInbox belongs to {linked_agent}, expected {agent_typeid}")

        return cls(
            id=inbox_typeid.id,
            address=descriptor.get("address"),
            display_name=descriptor.get("display_name"),
            provider=descriptor.get("provider"),
            provider_inbox_id=descriptor.get("provider_inbox_id"),
            status=descriptor.get("status"),
            agent_typeid=linked_agent,
            allowed_senders=list(descriptor.get("allowed_senders") or allowed_senders),
            filters=dict(descriptor.get("filters") or {}),
        )

    @classmethod
    def from_source(cls, source: "DataSource") -> "EmailInbox":
        """The mailbox as the INBOUND path sees it — no Hub call, no DB read.

        ``handle_inbound`` already holds the DataSource and runs per message, so
        the gate has to be answerable from what is in hand. The source carries
        everything needed: the Hub identity that :meth:`ensure_source` stamped
        into its config, the cached allowlist, and its own status — which is what
        "active" means locally, since a paused source is this machine not
        listening.

        One argument on purpose: taking the Agent too would make it look as
        though the gate consults it.
        """
        from flow_sdk.builtin.data_source import SourceStatus  # noqa: PLC0415

        config = getattr(source, "config", None) or {}
        listening = getattr(source, "status", None) == SourceStatus.ACTIVE.value
        agent_id = str(config.get("agent_id") or "")
        return cls(
            id=_inbox_id_from(config) or agent_id,
            address=str(config.get("address") or getattr(source, "account_key", "") or ""),
            provider=str(getattr(source, "provider", "") or ""),
            provider_inbox_id=str(config.get("provider_inbox_id") or ""),
            status=STATUS_ACTIVE if listening else STATUS_DISABLED,
            agent_typeid=TypeId(type=EntityType.AGENT.value, id=agent_id),
            allowed_senders=list(getattr(source, "inbound_allowed_senders", None) or []),
        )

    @classmethod
    async def for_agent(cls, agent) -> "Optional[EmailInbox]":
        """Refresh this Agent's mailbox projection from the Hub.

        ``None`` when the Agent was never published — asking the Hub about a row
        it has never seen is a round trip that can only answer "no".
        """
        from flow_sdk.builtin.email_inbox_driver import get_email_inbox_driver  # noqa: PLC0415

        if not getattr(agent, "remote", False):
            agent._inbox = None
            return None
        descriptor = await get_email_inbox_driver().get_inbox(agent.id)
        if not descriptor:
            agent._inbox = None
            return None
        return cls._adopt_onto(agent, descriptor)

    @classmethod
    def _adopt_onto(cls, agent, descriptor: Mapping[str, Any]) -> "EmailInbox":
        """Refresh the Agent's cached projection in place, keeping the object.

        Callers hold ``agent.inbox`` across a lifecycle call, so identity has to
        survive it — ``assert agent.inbox is allocated`` is a property the
        snippet relies on.
        """
        fresh = cls.from_hub_descriptor(descriptor, agent_typeid=agent.typeid)
        current = getattr(agent, "_inbox", None)
        adopted = fresh if (current is None or current.id != fresh.id) else current._adopt(descriptor)
        adopted._owner = agent
        # Cache HERE, for every caller. ``allocate()`` used to return the
        # projection without caching it, so ``agent.inbox`` stayed None after a
        # successful allocation — and anything keyed on that cache (the SDK
        # test's release-on-cleanup, for one) silently skipped, stranding a
        # billable address per run.
        agent._inbox = adopted
        return adopted

    # ── lifecycle ─────────────────────────────────────────────────────────

    @classmethod
    async def allocate(
        cls,
        agent,
        *,
        allowed_senders: "Sequence[str] | None" = None,
        **options: Any,
    ) -> "EmailInbox":
        """Allocate this Agent's mailbox, or adopt the one it already has.

        Idempotent, and that is not tidiness: an address is billable and
        permanent, and callers retry. Asking twice must never buy twice — which
        is enforced here and again at the Hub.

        The mailbox needs an Agent row on the Hub but not a Git deployment, so an
        unpublished Agent is registered through the ordinary share path first;
        this deliberately does not require a Project, GitHub, or a Git publish.
        """
        from flow_sdk.auth import LoginRequired  # noqa: PLC0415
        from flow_sdk.builtin.email_inbox_driver import (  # noqa: PLC0415
            EmailInboxError,
            EmailInboxErrorCode,
            get_email_inbox_driver,
        )
        from flow_sdk.cli.auth.hub_login import hub_auth_available  # noqa: PLC0415

        if not hub_auth_available():
            raise LoginRequired("FlowPad cloud login required to allocate an inbox")
        driver = get_email_inbox_driver()

        # One probe, one 401 rule. Splitting it by ``agent.remote`` meant the same
        # 401 raised ``LoginRequired`` on one path and a bare ``EmailInboxError``
        # on the other, and cost a second round trip for a published agent.
        existing = None
        try:
            existing = await driver.get_inbox(agent.id)
        except EmailInboxError as exc:
            if exc.code == EmailInboxErrorCode.TARGET_NOT_FOUND and not agent.remote:
                existing = await cls._publish_then_probe(agent, driver)
            elif exc.status_code == 401:
                raise LoginRequired("FlowPad cloud login required to allocate an inbox") from exc
            else:
                raise
        else:
            # A previous attempt can publish the Agent and then fail while
            # allocating its mailbox. Adopt that Hub row on retry.
            agent.remote = True

        try:
            descriptor = await driver.enable_inbox(agent.id, **options)
        except EmailInboxError as exc:
            if exc.status_code == 401:
                raise LoginRequired("FlowPad cloud login required to allocate an inbox") from exc
            raise

        # PERSIST the `remote` flip before returning. `share()` sets
        # `self.remote = True` in memory only (`entity_model.py:2092` — no save),
        # and `agent.remote = True` above is likewise in-memory. Every subsequent
        # request loads a FRESH Agent row, so an unpersisted flip reads back
        # `False` — and `for_agent()` short-circuits on exactly that before it ever
        # asks the Hub. The symptom was: allocate succeeds and the address renders,
        # then the very next `configure_inbox` answers 404 "this agent has no
        # inbox". Proven from the backend log: the failing request logged NO hub
        # `GET .../email_inbox` at all, i.e. it never reached the driver.
        if getattr(agent, "remote", False):
            try:
                await agent.save()
            except Exception:  # noqa: BLE001 - the mailbox exists either way
                logging.exception("EmailInbox.allocate: could not persist agent.remote")

        inbox = cls._adopt_onto(agent, descriptor)
        inbox.newly_allocated = not existing
        # The source first: it is where the gate's cache lives, so it has to
        # exist before any policy can be cached onto it.
        await inbox.ensure_source()
        if allowed_senders is not None:
            # After the mailbox exists, because the policy is the MAILBOX's — the
            # Hub has nothing to attach it to until then.
            await inbox.set_policy(allowed_senders=allowed_senders)
        else:
            await inbox._cache_policy()
        return inbox

    @classmethod
    async def _publish_then_probe(cls, agent, driver):
        """Resolve what ``target_not_found`` actually meant, and return the inbox.

        ``HubErrorCode.TARGET_NOT_FOUND`` is deliberately ambiguous — its own
        definition says so: *"the target entity doesn't exist OR the caller holds
        no role on it — the hub deliberately doesn't distinguish, so entity
        existence doesn't leak."* Publishing is the right answer to the first
        reading and guaranteed to fail on the second, so this asks rather than
        assumes.

        Publishing an agent the hub already holds answers 409. That is not a
        failure to report as-is — it is the ambiguity resolving itself: the agent
        IS on the hub, we simply could not see it. So we adopt it and probe once
        more. If the mailbox is now readable the agent was ours all along (a row
        published from another instance); if it still is not, the agent belongs
        to someone else, and THAT is the sentence worth showing — not the hub's
        "a conflicting record already exists", which describes a database
        constraint rather than anything the reader can act on.
        """
        from flow_sdk.builtin.email_inbox_driver import (  # noqa: PLC0415
            EmailInboxError,
            EmailInboxErrorCode,
        )

        try:
            await agent.share()
        # Narrow on purpose. `share()` reports a refused publish as a ValueError
        # (`FlowpadClient._unwrap` raises one for any non-200) and a missing login
        # as a RuntimeError; a transport failure raises httpx's own, and that must
        # propagate as itself — answering a hub outage with "belongs to another
        # account" would be a fabricated diagnosis, which is worse than the raw
        # error this whole change replaced. The real fix is a typed `HubError` out
        # of `_unwrap`; that is a cross-cutting change to every FlowpadClient
        # caller, so it stays a follow-up.
        except (ValueError, RuntimeError):
            agent.remote = True
            try:
                return await driver.get_inbox(agent.id)
            except EmailInboxError as still_hidden:
                agent.remote = False
                raise EmailInboxError(
                    403,
                    "this agent already exists on the hub under another account, so its "
                    "mailbox cannot be allocated from here — allocate it from the account "
                    "that owns the agent, or use an agent of your own",
                    code=EmailInboxErrorCode.FOREIGN_TARGET,
                ) from still_hidden
        return None

    async def disable(self) -> "EmailInbox":
        """Turn the mailbox off, keeping the address and the source's cursor.

        A later :meth:`allocate` resumes from the last committed position, so a
        pause costs no mail.
        """
        from flow_sdk.builtin.data_source import SourceStatus  # noqa: PLC0415
        from flow_sdk.builtin.email_inbox_driver import get_email_inbox_driver  # noqa: PLC0415

        self._adopt(await get_email_inbox_driver().disable_inbox(self.agent_id))
        source = await self.source()
        if source is not None and source.status != SourceStatus.DISABLED.value:
            source.status = SourceStatus.DISABLED.value
            await source.save()
        return self

    async def release(self) -> bool:
        """Release the address. ``False`` when there was nothing to release.

        Terminal, and deliberately NOT part of deleting an Agent: the address is
        the mailbox's public identity, and dropping it has consequences off this
        machine — mail to it starts bouncing. It stays an explicit verb.
        """
        from flow_sdk.builtin.data_source import SourceStatus  # noqa: PLC0415
        from flow_sdk.builtin.email_inbox_driver import get_email_inbox_driver  # noqa: PLC0415

        released = await get_email_inbox_driver().delete_inbox(self.agent_id)
        if released:
            self.status = STATUS_DELETED
            source = await self.source()
            if source is not None:
                # The allowlist described a mailbox that no longer exists.
                source.inbound_allowed_senders = []
                source.status = SourceStatus.DISABLED.value
                await source.save()
        owner = self._owner
        if owner is not None:
            owner._inbox = None
        return released

    async def configure(
        self,
        *,
        allowed_senders: "Sequence[str] | None" = None,
        filters: "dict | None" = None,
        poll_interval_seconds: "int | None" = None,
    ) -> dict:
        """Update this mailbox's policy and the cadence of the source polling it.

        The policy half is the Hub's — it stores and enforces it. The cadence is
        local: how often THIS machine polls is not a fact about the mailbox.

        Returns the same shape as :meth:`state`, so a caller that configures and
        re-renders makes one round trip.
        """
        from flow_sdk.builtin.data_source import MIN_POLL_INTERVAL_SECONDS  # noqa: PLC0415

        await self.set_policy(allowed_senders=allowed_senders, filters=filters)

        if poll_interval_seconds is not None:
            if poll_interval_seconds < MIN_POLL_INTERVAL_SECONDS:
                raise ValueError(f"poll_interval_seconds must be at least {MIN_POLL_INTERVAL_SECONDS}")
            source = await self.source()
            if source is None:
                raise ValueError("allocate the inbox before configuring its refresh interval")
            if source.poll_interval_seconds != poll_interval_seconds:
                source.poll_interval_seconds = poll_interval_seconds
                await source.save()
        return await self.state()

    async def set_policy(
        self,
        *,
        allowed_senders: "Sequence[str] | None" = None,
        filters: "dict | None" = None,
    ) -> "EmailInbox":
        """Write the Hub-owned half of the settings. Returns self.

        Separate from :meth:`configure` because writing policy and rendering the
        UI's state are different jobs: ``allocate`` wants the first without
        paying for the second.
        """
        from flow_sdk.builtin.email_inbox_driver import get_email_inbox_driver  # noqa: PLC0415

        settings: dict = {}
        if allowed_senders is not None:
            settings["allowed_senders"] = list(allowed_senders)
        if filters is not None:
            settings["filters"] = dict(filters)
        if settings:
            # Adopt what the Hub STORED, not what we sent: it normalizes, so the
            # two would disagree the moment anybody types a capital letter.
            self._adopt(await get_email_inbox_driver().configure_inbox(self.agent_id, settings))
            await self._cache_policy()
        return self

    # ── the paired local source ───────────────────────────────────────────

    async def source(self) -> "Optional[DataSource]":
        """The one local ``cloud_email`` source polling this mailbox, if any."""
        return await email_source_for_agent(self.agent_id)

    async def ensure_source(self) -> "DataSource":
        """Find or create the source that polls this mailbox, and activate it.

        ``agent_id`` is the natural key because the Hub still addresses a mailbox
        by Agent. The allocated address is attribution data: it names the account
        and lets the projection recognize the Agent's own sent copies.

        Writes only when something actually changed — this runs on every read of
        the inbox state, and an unconditional save put a row write on a poll.
        """
        import flow_sdk.ingest.drivers  # noqa: F401, PLC0415 — register drivers
        from flow_sdk.builtin.data_source import DataSource, SourceStatus  # noqa: PLC0415
        from flow_sdk.ingest.drivers.cloud_email import CloudEmailDriver  # noqa: PLC0415

        config = {
            CloudEmailDriver.identity_config_key: self.agent_id,
            "address": self.address,
            "inbox_typeid": str(self.typeid),
            "provider_inbox_id": self.provider_inbox_id,
        }
        source = await self.source()
        if source is None:
            source = DataSource(
                name=f"Inbox {self.address}",
                provider=CloudEmailDriver.provider,
                kind=CloudEmailDriver.kind,
                config=config,
                account_key=self.address,
                account_identities=[self.address],
                owner=self.agent_typeid,
            )
            await source.save()
            return source

        wanted = {
            "config": {**(source.config or {}), **config},
            "owner": self.agent_typeid,
            "kind": CloudEmailDriver.kind,
            "account_key": self.address,
            "account_identities": [self.address],
            "status": SourceStatus.ACTIVE.value,
        }
        changed = any(getattr(source, field) != value for field, value in wanted.items())
        if changed or source.next_poll_at is not None:
            for field, value in wanted.items():
                setattr(source, field, value)
            source.next_poll_at = None
            await source.save()
        return source

    # ── projection ────────────────────────────────────────────────────────

    #: What travels to a client. Declared as a field set rather than a hand-built
    #: dict — the ``LLMEndpoint`` precedent — so a field added to this class
    #: reaches the wire instead of being silently dropped by a forgotten literal.
    #: ``allowed_senders`` and ``filters`` are listed although they are
    #: ``Persist.FALSE``: a UI that cannot see the policy cannot render it.
    WIRE_FIELDS: ClassVar[frozenset[str]] = frozenset((*_HUB_FIELDS, "allowed_senders", "filters"))

    def descriptor(self) -> dict:
        """The wire view of this mailbox — the Hub's descriptor shape, plus policy."""
        data = self.model_dump(mode="json", include=self.WIRE_FIELDS)
        data["typeid"] = str(self.typeid)
        data["agent_typeid"] = str(self.agent_typeid)
        return data

    async def state(self) -> dict:
        """The narrow projection the Agent Inbox UI renders."""
        return await _state_payload(self.agent_id, self, await self.source())

    @classmethod
    async def state_for_agent(cls, agent) -> dict:
        """Reconcile an Agent's mailbox against the Hub and report it.

        Answers for an Agent with no mailbox at all, which is why it is a
        classmethod rather than an instance one: the UI asks this before there is
        anything to ask it of. Reconciling here — rather than trusting a cached
        flag — is what keeps "on" meaning the Hub says active AND this machine is
        polling.
        """
        from flow_sdk.auth import LoginRequired  # noqa: PLC0415
        from flow_sdk.builtin.data_source import SourceStatus  # noqa: PLC0415
        from flow_sdk.cli.auth.hub_login import hub_auth_available  # noqa: PLC0415

        if not hub_auth_available():
            raise LoginRequired("FlowPad cloud login required to load agent email")

        inbox = await cls.for_agent(agent)
        if inbox is not None and inbox.is_active:
            source = await inbox.ensure_source()
            await inbox._cache_policy(source)
        else:
            source = await email_source_for_agent(agent.id)
            if source is not None and source.status != SourceStatus.DISABLED.value:
                source.status = SourceStatus.DISABLED.value
                await source.save()
        return await _state_payload(agent.id, inbox, source)

    # ── messages ──────────────────────────────────────────────────────────

    async def messages(self, **filters: Any) -> dict:
        """A page of this mailbox's messages.

        Filters are the Hub's wire names — ``limit``, ``page_token``, ``from``,
        ``to``, ``subject``, ``labels``, ``before``, ``after``, ``ascending``.
        ``from`` is a Python keyword, so pass it as ``**{"from": ...}``.
        """
        from flow_sdk.builtin.email_inbox_driver import get_email_inbox_driver  # noqa: PLC0415

        return await get_email_inbox_driver().list_messages(self.agent_id, **filters)

    async def message(self, message_id: str) -> dict:
        """One message, body included — :meth:`messages` carries only a preview."""
        from flow_sdk.builtin.email_inbox_driver import get_email_inbox_driver  # noqa: PLC0415

        return await get_email_inbox_driver().get_message(self.agent_id, message_id)

    async def send(self, body: dict) -> dict:
        from flow_sdk.builtin.email_inbox_driver import get_email_inbox_driver  # noqa: PLC0415

        return await get_email_inbox_driver().send(self.agent_id, body)

    async def reply(self, message_id: str, body: dict) -> dict:
        from flow_sdk.builtin.email_inbox_driver import get_email_inbox_driver  # noqa: PLC0415

        return await get_email_inbox_driver().reply(self.agent_id, message_id, body)

    # ── internals ─────────────────────────────────────────────────────────

    def _adopt(self, descriptor: "Mapping[str, Any] | None") -> "EmailInbox":
        """Refresh identity and policy in place from a Hub descriptor.

        In place, keeping this object: callers hold ``agent.inbox`` across a
        lifecycle call, so a replacement would leave them pointing at the state
        before it. The one adopter for every verb the Hub answers with a
        descriptor — ``disable`` and ``configure`` differ in what they ask for,
        never in how they absorb the answer.
        """
        if not descriptor:
            return self
        fresh = EmailInbox.from_hub_descriptor(
            descriptor, agent_typeid=self.agent_typeid, allowed_senders=self.allowed_senders
        )
        for field in _HUB_FIELDS:
            setattr(self, field, getattr(fresh, field))
        self.allowed_senders = list(fresh.allowed_senders)
        self.filters = dict(fresh.filters)
        return self

    async def owner(self):
        """The owning Agent — the bound one, else loaded by id."""
        if self._owner is None:
            from flow_sdk.builtin.agent import Agent  # noqa: PLC0415

            self._owner = await Agent.get_by_id(self.agent_id)
        return self._owner

    async def _cache_policy(self, source=None) -> None:
        """Mirror the Hub's allowlist onto the source that polls this mailbox.

        The Hub is authoritative; this is a CACHE, and it exists for exactly one
        reason: ``allowed()`` runs on every inbound message and must not make a
        network call. It is ``Sharing.PRIVATE`` so the addresses never leave this
        machine, and it is never read to answer "what is the policy" — only to
        apply it.

        It lives on the mailbox's own ``DataSource`` rather than on the Agent so
        that it is scoped, and invalidated, with the thing it describes: releasing
        the mailbox drops the row and the cache with it.
        """
        source = source or await self.source()
        if source is None:
            return
        cached = list(self.allowed_senders)
        if list(source.inbound_allowed_senders or []) != cached:
            source.inbound_allowed_senders = cached
            await source.save()


def _source_summary(source) -> dict:
    """The compact row the inbox state carries for one DataSource."""
    return {
        "id": source.id,
        "typeid": str(source.typeid),
        "status": source.status,
        "channel": getattr(source, "channel", "") or "",
        "provider": getattr(source, "provider", "") or "",
        "poll_interval_seconds": source.poll_interval_seconds,
        "last_synced_at": (
            source.last_synced_at.isoformat() if hasattr(source.last_synced_at, "isoformat") else source.last_synced_at
        ),
        "health": getattr(source.health, "value", source.health),
    }


async def _state_payload(agent_id: str, inbox: "Optional[EmailInbox]", source) -> dict:
    """The one shape both state readers return.

    ``enabled`` is DERIVED, never stored: the Hub says whether the address is
    live and the source says whether this machine is listening, and a third
    persisted flag could only disagree with both.

    ``sources`` is every message source the agent OWNS — the mailbox is one of
    them, and today usually the only one. ``source`` stays as the mailbox's
    row for the readers that predate an agent holding more than one channel.
    """
    from flow_sdk.builtin.data_source import DataSource, SourceStatus  # noqa: PLC0415
    from flow_sdk.inbox.agent_scope import is_message_source  # noqa: PLC0415

    owned = await DataSource.find_owned(TypeId(type=EntityType.AGENT.value, id=str(agent_id)))
    sources_data = [_source_summary(s) for s in sorted(owned, key=lambda s: str(s.id)) if is_message_source(s)]

    source_data = None
    if source is not None:
        source_data = {
            "id": source.id,
            "typeid": str(source.typeid),
            "status": source.status,
            "poll_interval_seconds": source.poll_interval_seconds,
            "last_synced_at": (
                source.last_synced_at.isoformat()
                if hasattr(source.last_synced_at, "isoformat")
                else source.last_synced_at
            ),
            "health": getattr(source.health, "value", source.health),
        }
    return {
        "agent_id": agent_id,
        "sources": sources_data,
        "enabled": bool(
            inbox is not None and inbox.is_active and source is not None and source.status == SourceStatus.ACTIVE.value
        ),
        "inbox": inbox.descriptor() if inbox is not None else None,
        "source": source_data,
    }


__all__ = [
    "EmailInbox",
    "STATUS_ACTIVE",
    "STATUS_DELETED",
    "STATUS_DISABLED",
    "email_source_for_agent",
]
