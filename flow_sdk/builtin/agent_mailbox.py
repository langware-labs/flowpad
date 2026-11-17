"""The Agent's mailbox — a functional entity, not a descriptor.

The Hub allocates one mailbox per Agent and owns its formal identity: the
provider, the provider's opaque id for it (``provider_inbox_id``), the public
address, and the lifecycle status. This module is the SDK's side of that
mailbox, and it owns the *verbs* — who may drive it, whether it is on, what
polls it, how a message is sent.

**A transient projection, not a local row.** Same shape as ``LLMEndpoint``
(``flow_sdk/builtin/llm_endpoint.py``): ``_api_visible`` is False and
``_hub_only`` is True because there is nothing local to serve or to share — an
instance is built from the Hub's descriptor on demand, and :meth:`save` refuses.
Behaviour does not require storage, and a local copy of the Hub's row could only
drift from it.

**Why the verbs live here and not on ``Agent``.** A mailbox's policy is the
mailbox's: ``mailbox.allowed(address)`` says what it means, where the old
``agent.may_email(address)`` read as outbound permission and meant the opposite.
An Agent holds a mailbox; it is not one. ``Agent`` keeps exactly two things — the
``mailbox`` accessor and the one idempotent ``allocate_mailbox()`` call.

**Three verbs, and they are genuinely distinct.**

* **allocate** — idempotent (see :meth:`AgentMailbox.allocate`). Allocates at the
  Hub *or adopts what is already allocated*, wires the ``cloud_email`` source,
  turns both on. There is no separate "enable": enabling a mailbox you do not
  have and re-enabling one you do are the same request, and one less state for a
  caller to get wrong.
* **disable** — reversible. The address, the Hub row, the source and its cursor
  all survive, so a pause costs no mail. An on/off switch must never release a
  billable public identity as a side effect.
* **release** — terminal. The address is gone and mail to it bounces.

**``allowed`` is pure and synchronous, and that is load-bearing.** It runs on
every inbound message an agent's serve loop answers (``flow_sdk/builtin/agent_serve.py``), so it must never
reach the Hub or the database — which is why :meth:`from_source` exists and why
``allowed_senders`` rides on the projection as a runtime-only field. That is
also what lets its storage move to the Hub later without this file's callers or
their tests changing: only the constructors do.
"""

from __future__ import annotations

import contextlib
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
    """The local ``cloud_email`` source for an agent, mailbox or no mailbox.

    A module function rather than a method because the two callers that need it
    most — reporting state, and disabling — have to work when there is no
    mailbox at all and therefore no projection to hang it off.
    """
    from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415

    CloudEmailDriver = DataDriver.loaded("cloud_email")  # noqa: N806 — the registered source

    return await DataSource.find_for_account(
        CloudEmailDriver.provider,
        CloudEmailDriver.identity_config_key,
        str(agent_id or ""),
        owner=TypeId(type=EntityType.AGENT.value, id=str(agent_id or "")),
    )


async def channels_block(agent_id: str) -> str:
    """What the agent is told about its built-in email — its address, how replies work, how to send, who it
    hears from. ``""`` when it has none. Read from the local source alone (no Hub call): a launch must not
    wait on the network, and the Hub enforces the Sending list on every send whatever this says."""
    from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415

    # Nothing to tell where the built-in email channel is not even loaded — and a launch must never
    # fail for a channel it does not have.
    if DataDriver.loaded("cloud_email") is None:
        return ""
    try:
        source = await email_source_for_agent(agent_id)
    except Exception:  # noqa: BLE001 — what the agent is told about email never blocks its launch
        logging.getLogger(__name__).warning("agent %s: could not read its built-in email", agent_id, exc_info=True)
        return ""
    if source is None:
        return ""
    address = str((source.config or {}).get("address") or getattr(source, "account_key", "") or "")
    if not address:
        return ""
    hears = (
        "anyone (Open to all)"
        if getattr(source, "open_to_all", False)
        else (", ".join(source.allowed_senders or []) or "nobody yet")
    )
    lines = [
        "## Your email (built-in, added by Flowpad)",
        f"Your email address is {address}.",
        "A reply to an email you receive is sent for you, in the same thread: just write the answer.",
        "To send a new email, run:",
        f'  flow source send {source.id} --to "<address>[, <address>]" --subject "<subject>" '
        '[--cc "<address>"] (--text "<plain text>" | --html-file <file.html>)',
        "It is sent from your address. The Hub sends only to the people on your Sending list; a refused send "
        "names who is not on it — report that, do not retry another way.",
        f"Mail you read and answer comes from: {hears}.",
    ]
    if source.blocked_senders:
        lines.append(f"Never answer: {', '.join(source.blocked_senders)}.")
    return "\n".join(lines)


#: How often one source may re-read its mailbox's allowlist from the Hub after refusing a sender.
POLICY_REFRESH_SECONDS = 30.0
_policy_read_at: dict[str, float] = {}


async def refresh_policy_for(source) -> bool:
    """Re-read the Hub's allowlist onto *source*, when it polls an agent mailbox; answers whether it did.

    The allowlist is a private, runtime-only field of the source: the machine where the person saved
    it holds it, every other machine starts empty. A cloud placement's source comes with its deploy
    and was never configured there, so its gate refused everyone; and a sender blocked after the
    copy was taken stayed admitted. The serve loop calls this before the gate on every message, at
    most once per ``POLICY_REFRESH_SECONDS`` per source, so mail costs no more than one Hub read a window.
    """
    import logging  # noqa: PLC0415
    import time  # noqa: PLC0415

    from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415

    driver = DataDriver.loaded("cloud_email")
    if driver is None or getattr(source, "provider", "") != driver.provider:
        return False
    key = str(getattr(source, "id", "") or "")
    now = time.monotonic()
    if now - _policy_read_at.get(key, float("-inf")) < POLICY_REFRESH_SECONDS:
        return False
    _policy_read_at[key] = now
    from flow_sdk.builtin.agent_mailbox_driver import get_agent_mailbox_driver  # noqa: PLC0415
    from flow_sdk.stream_inbox.projection import agent_id_of  # noqa: PLC0415

    # By agent id, straight from the Hub: a cloud machine's copy of the agent is not marked published
    # (``remote``), so ``for_agent`` would answer None there without asking.
    agent_id = agent_id_of(source)
    try:
        descriptor = await get_agent_mailbox_driver().get_mailbox(agent_id)
    except Exception as exc:  # noqa: BLE001 — an unreachable Hub leaves the gate's answer as it was
        logging.getLogger(__name__).info("agent %s: could not re-read the mailbox allowlist: %s", agent_id, exc)
        return False
    if not descriptor:
        return False
    mailbox = AgentMailbox.from_hub_descriptor(descriptor, agent_typeid=TypeId(type=EntityType.AGENT.value, id=agent_id))
    await mailbox._cache_policy(source)
    return True


def _mailbox_id_from(config: Mapping[str, Any]) -> str:
    """The mailbox id stamped in a source's config, or ``""`` when absent/unparseable.

    Read through the ``cloud_email`` driver's ``lift`` so a source stamped under a retired key
    still names its mailbox before the next ``ensure_source`` rewrites it.
    """
    from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415

    driver = DataDriver.loaded("cloud_email")
    lifted = driver.cls.Config.lift(config) if driver is not None else config
    raw = str(lifted.get("mailbox_typeid") or "").strip()
    if not raw:
        return ""
    try:
        return TypeId(raw).id or ""
    except Exception:  # noqa: BLE001 — a malformed stamp is missing, not fatal
        return ""


def on_list(entries, address: str) -> bool:
    """Whether ``address`` matches an entry of ``entries``: the exact address, or its whole domain written ``@domain``.

    Case- and whitespace-insensitive through ``normalize_email``, the funnel every address comparison
    uses, so this keeps agreeing with ``is_self_address``; a non-email handle passes through it unchanged.
    """
    from flow_sdk.builtin.user import normalize_email  # noqa: PLC0415

    candidate = normalize_email(address or "")
    if not candidate:
        return False
    domain = "@" + candidate.rsplit("@", 1)[1] if "@" in candidate else ""
    for raw in entries or []:
        entry = str(raw or "").strip().lower()
        if entry.startswith("@"):
            if domain and entry == domain:
                return True
        elif candidate == normalize_email(entry):
            return True
    return False


def sender_allowed(allowlist, address: str, blocked=(), *, open_to_all: bool = False) -> bool:
    """Whether ``address`` may write in — THE Receiving fold: Blocked wins, then Open to all, then the Allowed
    list. An empty Allowed list admits nobody."""
    return not on_list(blocked, address) and (open_to_all or on_list(allowlist, address))


#: The mailbox's address lists (Receiving: senders; Sending: recipients) and its two "Open to all" switches —
#: the Hub's names, stored and enforced there, mirrored here.
POLICY_LISTS = ("allowed_senders", "blocked_senders", "allowed_recipients", "blocked_recipients")
POLICY_SWITCHES = ("open_senders", "open_recipients")


class AgentMailbox(Entity):
    """One Agent's mailbox: Hub-owned identity, SDK-owned behaviour."""

    _api_visible: ClassVar[bool] = False
    _hub_only: ClassVar[bool] = True

    type: str = APIField(default=EntityType.AGENT_MAILBOX.value)
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
    #: The rest of the two directions, same vocabulary (an address or ``@domain``). Receiving: Blocked beats
    #: Allowed. Sending: who the agent may write to — the Hub refuses a send to anyone else.
    blocked_senders: list[str] = APIField(default_factory=list, persist=Persist.FALSE, sharing=Sharing.PRIVATE)
    allowed_recipients: list[str] = APIField(default_factory=list, persist=Persist.FALSE, sharing=Sharing.PRIVATE)
    blocked_recipients: list[str] = APIField(default_factory=list, persist=Persist.FALSE, sharing=Sharing.PRIVATE)
    #: "Open to all" per direction. A Hub too old to say has no Sending gate, so it reads open.
    open_senders: bool = APIField(default=False, persist=Persist.FALSE)
    open_recipients: bool = APIField(default=True, persist=Persist.FALSE)
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
            "an AgentMailbox is the hub's row — it has no local copy to save; "
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
        return self.is_active and sender_allowed(
            self.allowed_senders, address, self.blocked_senders, open_to_all=self.open_senders
        )

    # ── constructors ──────────────────────────────────────────────────────

    @classmethod
    def from_hub_descriptor(
        cls,
        descriptor: Mapping[str, Any],
        *,
        agent_typeid: TypeId,
        allowed_senders: Sequence[str] = (),
    ) -> "AgentMailbox":
        """Adopt and validate the Hub identity carried by a mailbox descriptor.

        Policy comes from the descriptor: the Hub row owns the allowlist and the
        read defaults, so what a client shows and what the Hub enforces cannot
        diverge. ``allowed_senders`` remains as a fallback for a Hub too old to
        carry it — never as an override, because a local answer to "who may drive
        this agent" is exactly the second source of truth this removed.
        """
        descriptor = {**descriptor, "allowed_senders": descriptor.get("allowed_senders") or list(allowed_senders)}
        mailbox_typeid = TypeId(str(descriptor.get("typeid") or ""))
        if (
            mailbox_typeid.type != EntityType.AGENT_MAILBOX.value
            or not mailbox_typeid.id
            or not is_valid_entity_id(mailbox_typeid.id)
        ):
            raise ValueError(f"Invalid Hub AgentMailbox TypeId: {mailbox_typeid}")

        linked_agent = TypeId(str(descriptor.get("agent_typeid") or ""))
        if (
            linked_agent.type != EntityType.AGENT.value
            or not linked_agent.id
            or not is_valid_entity_id(linked_agent.id)
            or linked_agent != agent_typeid
        ):
            raise ValueError(f"AgentMailbox belongs to {linked_agent}, expected {agent_typeid}")

        return cls(
            id=mailbox_typeid.id,
            address=descriptor.get("address"),
            display_name=descriptor.get("display_name"),
            provider=descriptor.get("provider"),
            provider_inbox_id=descriptor.get("provider_inbox_id"),
            status=descriptor.get("status"),
            agent_typeid=linked_agent,
            **{name: list(descriptor.get(name) or []) for name in POLICY_LISTS},
            open_senders=bool(descriptor.get("open_senders", False)),
            open_recipients=bool(descriptor.get("open_recipients", True)),
            filters=dict(descriptor.get("filters") or {}),
        )

    @classmethod
    def from_source(cls, source: "DataSource") -> "AgentMailbox":
        """The mailbox as the INBOUND path sees it — no Hub call, no DB read.

        The serve loop already holds the DataSource and runs per message, so
        the gate has to be answerable from what is in hand. The source carries
        everything needed: the Hub identity that :meth:`ensure_source` stamped
        into its config, the cached allowlist, and its own status — which is what
        "active" means locally, since a paused source is this machine not
        listening.

        One argument on purpose: taking the Agent too would make it look as
        though the gate consults it.

        ``agent_id`` goes through ``agent_id_of`` — not a bare ``config.get``
        — because an agent-owned channel source (Slack, Teams, …) carries no
        ``config.agent_id`` at all; its agent is the ``owner``. The serve loop
        only reaches here over sources that agent owns, so the
        helper's fallback is never empty at this call site — a bare
        ``config.get`` left it empty for every such source, and constructing
        ``TypeId(..., id="")`` below raised on every single one of them.
        """
        from flow_sdk.builtin.data_source import SourceStatus  # noqa: PLC0415
        from flow_sdk.stream_inbox.projection import agent_id_of  # noqa: PLC0415

        config = getattr(source, "config", None) or {}
        listening = getattr(source, "status", None) == SourceStatus.ACTIVE.value
        agent_id = agent_id_of(source)
        return cls(
            id=_mailbox_id_from(config) or agent_id,
            address=str(config.get("address") or getattr(source, "account_key", "") or ""),
            provider=str(getattr(source, "provider", "") or ""),
            provider_inbox_id=str(config.get("provider_inbox_id") or ""),
            status=STATUS_ACTIVE if listening else STATUS_DISABLED,
            agent_typeid=TypeId(type=EntityType.AGENT.value, id=agent_id),
            allowed_senders=list(getattr(source, "allowed_senders", None) or []),
            blocked_senders=list(getattr(source, "blocked_senders", None) or []),
            open_senders=bool(getattr(source, "open_to_all", False)),
        )

    @classmethod
    async def for_agent(cls, agent) -> "Optional[AgentMailbox]":
        """Refresh this Agent's mailbox projection from the Hub.

        ``None`` when the Agent was never published — asking the Hub about a row
        it has never seen is a round trip that can only answer "no".
        """
        from flow_sdk.builtin.agent_mailbox_driver import get_agent_mailbox_driver  # noqa: PLC0415

        if not getattr(agent, "remote", False):
            agent._mailbox = None
            return None
        descriptor = await get_agent_mailbox_driver().get_mailbox(agent.id)
        if not descriptor:
            agent._mailbox = None
            return None
        return cls._adopt_onto(agent, descriptor)

    @classmethod
    def _adopt_onto(cls, agent, descriptor: Mapping[str, Any]) -> "AgentMailbox":
        """Refresh the Agent's cached projection in place, keeping the object.

        Callers hold ``agent.mailbox`` across a lifecycle call, so identity has to
        survive it — ``assert agent.mailbox is allocated`` is a property the
        snippet relies on.
        """
        fresh = cls.from_hub_descriptor(descriptor, agent_typeid=agent.typeid)
        current = getattr(agent, "_mailbox", None)
        adopted = fresh if (current is None or current.id != fresh.id) else current._adopt(descriptor)
        adopted._owner = agent
        agent._mailbox = adopted  # every adopt path caches, so allocate() does too
        return adopted

    # ── lifecycle ─────────────────────────────────────────────────────────

    @classmethod
    async def allocate(
        cls,
        agent,
        *,
        allowed_senders: "Sequence[str] | None" = None,
        **options: Any,
    ) -> "AgentMailbox":
        """Allocate this Agent's mailbox, or adopt the one it already has.

        Idempotent, and that is not tidiness: an address is billable and
        permanent, and callers retry. Asking twice must never buy twice — which
        is enforced here and again at the Hub.

        The mailbox needs an Agent row on the Hub but not a Git deployment, so an
        unpublished Agent is registered through the ordinary share path first;
        this deliberately does not require a Project, GitHub, or a Git publish.
        """
        from flow_sdk.auth import LoginRequired  # noqa: PLC0415
        from flow_sdk.builtin.agent_mailbox_driver import (  # noqa: PLC0415
            AgentMailboxError,
            AgentMailboxErrorCode,
            get_agent_mailbox_driver,
        )
        from flow_sdk.cli.auth.hub_login import hub_auth_available  # noqa: PLC0415

        if not hub_auth_available():
            raise LoginRequired("FlowPad cloud login required to allocate a mailbox")
        driver = get_agent_mailbox_driver()

        # One probe, one 401 rule. Splitting it by ``agent.remote`` meant the same
        # 401 raised ``LoginRequired`` on one path and a bare ``AgentMailboxError``
        # on the other, and cost a second round trip for a published agent.
        existing = None
        try:
            existing = await driver.get_mailbox(agent.id)
        except AgentMailboxError as exc:
            if exc.code == AgentMailboxErrorCode.TARGET_NOT_FOUND and not agent.remote:
                existing = await cls._publish_then_probe(agent, driver)
            elif exc.status_code == 401:
                raise LoginRequired("FlowPad cloud login required to allocate a mailbox") from exc
            else:
                raise
        else:
            # A previous attempt can publish the Agent and then fail while
            # allocating its mailbox. Adopt that Hub row on retry.
            agent.remote = True

        # An ACTIVE mailbox is adopted as it is. Enabling is a lifecycle change only its human owner may make; a
        # machine signed in as the agent (a private deployment's person machine) adopts and wires its source, and
        # asking the hub to enable it there would be refused.
        if isinstance(existing, dict) and existing.get("status") == "active" and not options:
            descriptor = existing
        else:
            descriptor = None
        try:
            descriptor = descriptor or await driver.enable_mailbox(agent.id, **options)
        except AgentMailboxError as exc:
            if exc.status_code == 401:
                raise LoginRequired("FlowPad cloud login required to allocate a mailbox") from exc
            raise

        # PERSIST the `remote` flip before returning. `share()` sets
        # `self.remote = True` in memory only (`entity_model.py:2092` — no save),
        # and `agent.remote = True` above is likewise in-memory. Every subsequent
        # request loads a FRESH Agent row, so an unpersisted flip reads back
        # `False` — and `for_agent()` short-circuits on exactly that before it ever
        # asks the Hub. The symptom was: allocate succeeds and the address renders,
        # then the very next `configure_mailbox` answers 404 "this agent has no
        # mailbox". Proven from the backend log: the failing request logged NO hub
        # `GET .../mailbox` at all, i.e. it never reached the driver.
        if getattr(agent, "remote", False):
            try:
                await agent.save()
            except Exception:  # noqa: BLE001 - the mailbox exists either way
                logging.exception("AgentMailbox.allocate: could not persist agent.remote")

        mailbox = cls._adopt_onto(agent, descriptor)
        mailbox.newly_allocated = not existing
        # The source first: it is where the gate's cache lives, so it has to
        # exist before any policy can be cached onto it.
        await mailbox.ensure_source()
        if allowed_senders is not None:
            # After the mailbox exists, because the policy is the MAILBOX's — the
            # Hub has nothing to attach it to until then.
            await mailbox.set_policy(allowed_senders=allowed_senders)
        else:
            await mailbox._cache_policy()
        return mailbox

    @classmethod
    async def _publish_then_probe(cls, agent, driver):
        """Resolve what ``target_not_found`` actually meant, and return the mailbox.

        ``HubErrorCode.TARGET_NOT_FOUND`` is deliberately ambiguous — its own
        definition says so: *"the target entity doesn't exist OR the caller holds
        no role on it — the hub deliberately doesn't distinguish, so entity
        existence doesn't leak."* Publishing is the right answer to the first
        reading and guaranteed to fail on the second, so this asks rather than
        assumes.

        Publishing an agent the hub already holds answers 409, and ``share()``
        absorbs that 409 as "already there" — so a publish that RETURNS proves
        nothing about whose row it is. Only the probe after it can tell: we adopt
        the agent and probe once more. If the mailbox is now readable the agent
        was ours all along (a row published from another instance, or one this
        publish just created); if it still is not, the agent belongs
        to someone else, and THAT is the sentence worth showing — not the hub's
        "a conflicting record already exists", which describes a database
        constraint rather than anything the reader can act on.
        """
        from flow_sdk.builtin.agent_mailbox_driver import (  # noqa: PLC0415
            AgentMailboxError,
            AgentMailboxErrorCode,
        )

        # Narrow on purpose. `share()` reports a refused publish as a ValueError
        # (`FlowpadClient._unwrap` raises one for any non-200) and a missing login
        # as a RuntimeError; a transport failure raises httpx's own, and that must
        # propagate as itself — answering a hub outage with "belongs to another
        # account" would be a fabricated diagnosis, which is worse than the raw
        # error this whole change replaced. The real fix is a typed `HubError` out
        # of `_unwrap`; that is a cross-cutting change to every FlowpadClient
        # caller, so it stays a follow-up.
        from flow_sdk.cloud_client.shared.errors import HubError, HubErrorCode  # noqa: PLC0415

        foreign = AgentMailboxError(
            403,
            "this agent already exists on the hub under another account, so its "
            "mailbox cannot be allocated from here — allocate it from the account "
            "that owns the agent, or use an agent of your own",
            code=AgentMailboxErrorCode.FOREIGN_TARGET,
        )
        try:
            with contextlib.suppress(ValueError, RuntimeError):
                await agent.share()
        except HubError as refused:
            # A publish whose 409 the client already resolved as "the row at this id is not
            # ours" (``Entity.confirm_hub_row_is_ours``) is the same answer the probe below
            # would reach: someone else's agent. Anything else is its own failure.
            if refused.code != HubErrorCode.ID_TAKEN:
                raise
            agent.remote = False
            raise foreign from refused
        agent.remote = True
        try:
            return await driver.get_mailbox(agent.id)
        except AgentMailboxError as still_hidden:
            agent.remote = False
            # Only the masked answer means "someone else's". A 503 or a 401 here
            # is its own failure and must reach the caller as itself.
            if still_hidden.code != AgentMailboxErrorCode.TARGET_NOT_FOUND:
                raise
            raise foreign from still_hidden

    async def disable(self) -> "AgentMailbox":
        """Turn the mailbox off, keeping the address and the source's cursor.

        A later :meth:`allocate` resumes from the last committed position, so a
        pause costs no mail.
        """
        from flow_sdk.builtin.agent_mailbox_driver import get_agent_mailbox_driver  # noqa: PLC0415
        from flow_sdk.builtin.data_source import SourceStatus  # noqa: PLC0415

        self._adopt(await get_agent_mailbox_driver().disable_mailbox(self.agent_id))
        source = await self.source()
        if source is not None and source.status != SourceStatus.DISABLED.value:
            source.status = SourceStatus.DISABLED.value
            await source.save_runtime()
        return self

    async def release(self) -> bool:
        """Release the address. ``False`` when there was nothing to release.

        Terminal: the address is the mailbox's public identity, and dropping it
        has consequences off this machine — mail to it starts bouncing. Deleting
        the Agent releases it too (nobody is left to answer it).
        """
        from flow_sdk.builtin.agent_mailbox_driver import get_agent_mailbox_driver  # noqa: PLC0415
        from flow_sdk.builtin.data_source import SourceStatus  # noqa: PLC0415

        released = await get_agent_mailbox_driver().delete_mailbox(self.agent_id)
        if released:
            self.status = STATUS_DELETED
            source = await self.source()
            if source is not None:
                # The allowlist described a mailbox that no longer exists.
                source.allowed_senders = []
                source.status = SourceStatus.DISABLED.value
                await source.save_runtime()
        owner = self._owner
        if owner is not None:
            owner._mailbox = None
        return released

    async def configure(
        self,
        *,
        filters: "dict | None" = None,
        poll_interval_seconds: "int | None" = None,
        **policy: Any,
    ) -> dict:
        """Update this mailbox's policy and the cadence of the source polling it.

        The policy half is the Hub's — it stores and enforces it. The cadence is
        local: how often THIS machine polls is not a fact about the mailbox.

        Returns the same shape as :meth:`state`, so a caller that configures and
        re-renders makes one round trip.
        """
        from flow_sdk.builtin.data_source import MIN_POLL_INTERVAL_SECONDS  # noqa: PLC0415

        await self.set_policy(filters=filters, **policy)

        if poll_interval_seconds is not None:
            if poll_interval_seconds < MIN_POLL_INTERVAL_SECONDS:
                raise ValueError(f"poll_interval_seconds must be at least {MIN_POLL_INTERVAL_SECONDS}")
            source = await self.source()
            if source is None:
                raise ValueError("allocate the mailbox before configuring its refresh interval")
            if source.poll_interval_seconds != poll_interval_seconds:
                source.poll_interval_seconds = poll_interval_seconds
                await source.save()
        return await self.state()

    async def set_policy(self, *, filters: "dict | None" = None, **policy: Any) -> "AgentMailbox":
        """Write the Hub-owned half of the settings. Returns self.

        Separate from :meth:`configure` because writing policy and rendering the
        UI's state are different jobs: ``allocate`` wants the first without
        paying for the second.
        """
        from flow_sdk.builtin.agent_mailbox_driver import get_agent_mailbox_driver  # noqa: PLC0415

        unknown = sorted(set(policy) - {*POLICY_LISTS, *POLICY_SWITCHES})
        if unknown:
            raise ValueError(f"unknown mailbox setting(s): {', '.join(unknown)}")
        settings: dict = {}
        for name in POLICY_LISTS:
            if policy.get(name) is not None:
                settings[name] = list(policy[name])
        for name in POLICY_SWITCHES:
            if policy.get(name) is not None:
                settings[name] = bool(policy[name])
        if filters is not None:
            settings["filters"] = dict(filters)
        if settings:
            # Adopt what the Hub STORED, not what we sent: it normalizes, so the
            # two would disagree the moment anybody types a capital letter.
            self._adopt(await get_agent_mailbox_driver().configure_mailbox(self.agent_id, settings))
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
        the mailbox state, and an unconditional save put a row write on a poll.
        """
        from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415
        from flow_sdk.builtin.data_source import DataSource, SourceStatus  # noqa: PLC0415

        CloudEmailDriver = DataDriver.loaded("cloud_email")  # noqa: N806 — the registered source

        config = {
            CloudEmailDriver.identity_config_key: self.agent_id,
            "address": self.address,
            "mailbox_typeid": str(self.typeid),
            "provider_inbox_id": self.provider_inbox_id,
        }
        from flow_sdk.builtin.agent_places import email_answers_here  # noqa: PLC0415

        # Only the place chosen to answer this mailbox polls it; every other
        # machine keeps its source but stops (DISABLED), so replies never come twice.
        wanted_status = SourceStatus.ACTIVE.value if await email_answers_here(self.agent_id) else SourceStatus.DISABLED.value
        source = await self.source()
        if source is None:
            source = DataSource(
                name=f"Mailbox {self.address}",
                status=wanted_status,
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
            # Through the driver's own ``lift``, so a key it has retired leaves the row on this save.
            "config": CloudEmailDriver.cls.Config.lift({**(source.config or {}), **config}),
            "owner": self.agent_typeid,
            "kind": CloudEmailDriver.kind,
            "account_key": self.address,
            "account_identities": [self.address],
            "status": wanted_status,
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
    WIRE_FIELDS: ClassVar[frozenset[str]] = frozenset((*_HUB_FIELDS, *POLICY_LISTS, *POLICY_SWITCHES, "filters"))

    def descriptor(self) -> dict:
        """The wire view of this mailbox — the Hub's descriptor shape, plus policy."""
        data = self.model_dump(mode="json", include=self.WIRE_FIELDS)
        data["typeid"] = str(self.typeid)
        data["agent_typeid"] = str(self.agent_typeid)
        return data

    async def state(self) -> dict:
        """The narrow projection the agent mailbox settings UI renders."""
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

        mailbox = await cls.for_agent(agent)
        offered = True
        if mailbox is None:
            from flow_sdk.builtin.agent_mailbox_driver import get_agent_mailbox_driver  # noqa: PLC0415

            ask = getattr(get_agent_mailbox_driver(), "offered", None)
            try:
                offered = bool(await ask(agent.id)) if ask is not None else True
            except Exception:  # noqa: BLE001 — an unreachable hub says nothing about the offer
                offered = True
        if mailbox is not None and mailbox.is_active:
            source = await mailbox.ensure_source()
            await mailbox._cache_policy(source)
        else:
            source = await email_source_for_agent(agent.id)
            if source is not None and source.status != SourceStatus.DISABLED.value:
                source.status = SourceStatus.DISABLED.value
                await source.save_runtime()
        return {**await _state_payload(agent.id, mailbox, source), "offered": offered}

    # ── messages ──────────────────────────────────────────────────────────

    async def messages(self, **filters: Any) -> dict:
        """A page of this mailbox's messages.

        Filters are the Hub's wire names — ``limit``, ``page_token``, ``from``,
        ``to``, ``subject``, ``labels``, ``before``, ``after``, ``ascending``.
        ``from`` is a Python keyword, so pass it as ``**{"from": ...}``.
        """
        from flow_sdk.builtin.agent_mailbox_driver import get_agent_mailbox_driver  # noqa: PLC0415

        return await get_agent_mailbox_driver().list_messages(self.agent_id, **filters)

    async def message(self, message_id: str) -> dict:
        """One message, body included — :meth:`messages` carries only a preview."""
        from flow_sdk.builtin.agent_mailbox_driver import get_agent_mailbox_driver  # noqa: PLC0415

        return await get_agent_mailbox_driver().get_message(self.agent_id, message_id)

    async def send(self, body: dict) -> dict:
        from flow_sdk.builtin.agent_mailbox_driver import get_agent_mailbox_driver  # noqa: PLC0415

        return await get_agent_mailbox_driver().send(self.agent_id, body)

    async def reply(self, message_id: str, body: dict) -> dict:
        from flow_sdk.builtin.agent_mailbox_driver import get_agent_mailbox_driver  # noqa: PLC0415

        return await get_agent_mailbox_driver().reply(self.agent_id, message_id, body)

    # ── internals ─────────────────────────────────────────────────────────

    def _adopt(self, descriptor: "Mapping[str, Any] | None") -> "AgentMailbox":
        """Refresh identity and policy in place from a Hub descriptor.

        In place, keeping this object: callers hold ``agent.mailbox`` across a
        lifecycle call, so a replacement would leave them pointing at the state
        before it. The one adopter for every verb the Hub answers with a
        descriptor — ``disable`` and ``configure`` differ in what they ask for,
        never in how they absorb the answer.
        """
        if not descriptor:
            return self
        fresh = AgentMailbox.from_hub_descriptor(
            descriptor, agent_typeid=self.agent_typeid, allowed_senders=self.allowed_senders
        )
        for field in _HUB_FIELDS:
            setattr(self, field, getattr(fresh, field))
        for name in (*POLICY_LISTS, *POLICY_SWITCHES):
            value = getattr(fresh, name)
            setattr(self, name, list(value) if isinstance(value, list) else value)
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
        # Receiving is what this machine's gate applies; Sending the Hub enforces on every send.
        wanted = {
            "allowed_senders": list(self.allowed_senders),
            "blocked_senders": list(self.blocked_senders),
            "open_to_all": bool(self.open_senders),
        }
        if any(getattr(source, name, None) != value for name, value in wanted.items()):
            for name, value in wanted.items():
                setattr(source, name, value)
            await source.save_runtime()


def _source_summary(source) -> dict:
    """The compact row the mailbox state carries for one DataSource."""
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


async def _state_payload(agent_id: str, mailbox: "Optional[AgentMailbox]", source) -> dict:
    """The one shape both state readers return.

    ``enabled`` is DERIVED, never stored: the Hub says whether the address is
    live and the source says whether this machine is listening, and a third
    persisted flag could only disagree with both.

    ``sources`` is every message source the agent OWNS — the mailbox is one of
    them, and today usually the only one. ``source`` stays as the mailbox's
    row for the readers that predate an agent holding more than one channel.
    """
    from flow_sdk.builtin.data_source import DataSource, SourceStatus  # noqa: PLC0415
    from flow_sdk.stream_inbox.agent_scope import is_message_source  # noqa: PLC0415

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
            mailbox is not None and mailbox.is_active and source is not None and source.status == SourceStatus.ACTIVE.value
        ),
        "mailbox": mailbox.descriptor() if mailbox is not None else None,
        "source": source_data,
    }


__all__ = [
    "AgentMailbox",
    "STATUS_ACTIVE",
    "STATUS_DELETED",
    "STATUS_DISABLED",
    "email_source_for_agent",
]
