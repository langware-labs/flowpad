"""The driver contract — the only place provider knowledge is allowed to live.

A driver answers two questions and nothing else: *which streams does this source
have*, and *what has changed in one stream since we last looked*. It never
writes an entity, never emits an event, never advances a cursor.

**The cursor state it receives is its own.** ``SegmentCursorView.state`` is an
opaque dict the sync loop carries but never reads. That is what lets one loop
serve two genuinely different sync shapes:

* **conditional GET** (RSS/Atom) — the driver keeps ``{etag, last_modified}``
  and answers ``unchanged=True`` on a 304;
* **changed-ids / high-water** (Hacker News) — the driver keeps
  ``{last_update_ptr}``, asks the API what moved, and answers ``unchanged=True``
  when nothing did.

If the sync loop ever needs to look inside ``state``, the abstraction has leaked
and the next provider will need a special case.
``test_cursor_state_is_opaque_to_the_subsystem`` greps for exactly that.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable, Optional

from flow_sdk._compat import StrEnum
from flow_sdk.utils.kind_registry import KindRegistry

logger = logging.getLogger(__name__)

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.data_source import DataSource
    from flow_sdk.builtin.source_item import MessageSpec, SourceItemSpec


class SendStatus(StrEnum):
    """What actually became of an outbound message.

    An enum rather than booleans because the repo has settled this shape twice
    already — ``SourceHealth`` and ``LaunchHealth`` are both StrEnums with
    stable wire values — and because two independent flags spanned four states
    of which one was meaningless.

    SENT     — the channel confirmed delivery.
    DRAFTED  — composed into the channel for the user to send. Some connectors
               can write but not send: the claude.ai Gmail connector exposes
               `create_draft` and no send verb at all. A draft is a real
               outcome, not a failure — but it has reached nobody, so it is
               never recorded as a message.
    """

    SENT = "sent"
    DRAFTED = "drafted"


@dataclass(frozen=True)
class SendOutcome:
    """What the channel confirmed about one message.

    ``external_id`` is the provider's id for what it created — the same
    namespace an inbound record's ``external_id`` lives in, which is what lets
    a sent copy and any later fetch of it converge on one row.

    ``recorded`` says whether the transport also wrote the SourceItem. It is
    orthogonal to ``status`` and load-bearing: False on a SENT message means
    the mail is gone but the local copy is missing, and re-sending to fix the
    bookkeeping would mail the recipient twice.

    ``artifact_id`` is set when the transport registered the sent message as
    the run's deliverable. Empty is not a failure — a transport with no run
    behind it (a direct API send) has no producer to attribute an artifact to.
    """

    external_id: str = ""
    status: SendStatus = SendStatus.SENT
    recorded: bool = False
    artifact_id: str = ""

    @property
    def drafted(self) -> bool:
        """Sugar for the question every caller asks: is this waiting on the user?"""
        return self.status is SendStatus.DRAFTED


@dataclass(frozen=True)
class SetupVerdict:
    """Whether a source's setup is complete, and what is missing if not.

    ``pending`` is per-stream because that is the granularity a person acts at:
    "invite the bot to #eng and #design" is actionable, "some channels are not
    readable" is not.
    """

    ready: bool
    #: One line, in the user's words, shown verbatim on the card.
    detail: str = ""
    #: Stream keys still waiting on a human.
    pending: tuple[str, ...] = ()

    @classmethod
    def ok(cls, detail: str = "") -> "SetupVerdict":
        return cls(ready=True, detail=detail)

    @classmethod
    def waiting(cls, detail: str, pending: tuple[str, ...] = ()) -> "SetupVerdict":
        return cls(ready=False, detail=detail, pending=pending)


@dataclass(frozen=True)
class SegmentRef:
    """One syncable unit within a source — a feed URL, a channel.

    ``stamp`` is OPTIONAL: a change token the LISTING already carries (a
    message count, an updated-at, an etag). The sync records it on the
    cursor after a good fetch and, while the listing keeps answering the same
    token, does not fetch the stream again — and does not spend budget on
    it. A listing that cannot say leaves it empty and the stream is
    round-robined like any other.
    """

    key: str
    label: str = ""
    stamp: str = ""


@dataclass(frozen=True)
class SegmentCursorView:
    """What a driver is told about where it left off.

    ``window_start`` is the "since last pull" floor, already resolved. Drivers
    apply it as a filter on what they fetched; they do not compute it.
    """

    segment_key: str
    state: dict = field(default_factory=dict)
    window_start: Optional[str] = None
    first_run: bool = True


@dataclass(frozen=True)
class FetchResult:
    """What a driver found, plus the state it wants carried to next time."""

    items: list["SourceItemSpec"] = field(default_factory=list)
    #: Asset ROOTS that changed, for drivers whose payload is already local and
    #: whose destination is the filesystem rather than a ``SourceItem`` — the
    #: folder driver today. A path here is the asset root in the sense
    #: ``FSOrigin.rel_path`` already means: a FOLDER for folder-layout types, a
    #: FILE for file-layout ones.
    #:
    #: Deliberately separate from ``items`` rather than a variant of it. Reading
    #: a file's bytes into a ``SourceItemSpec`` only to write them straight back to
    #: disk is pure waste, and a driver that returns refs is announcing that its
    #: destination is ``reflect``, not ``ingest_items``.
    refs: list[str] = field(default_factory=list)
    #: Asset roots the source no longer has. Only a driver that can actually
    #: OBSERVE absence may fill this — an enumerate-diff can, a lossy watcher
    #: cannot, and "I did not see it" must never reach here (the rule
    #: ``rss.py`` states as "absence is never deletion").
    tombstones: list[str] = field(default_factory=list)
    #: ``{new_path: old_path}`` for refs the source reports as MOVED rather than
    #: replaced. Only a transport that can actually observe a move may fill this
    #: — git can (``--find-renames``), a lossy watcher cannot — and it is what
    #: lets identity travel with the asset instead of being destroyed at the old
    #: path and re-minted at the new one.
    renames: dict[str, str] = field(default_factory=dict)
    next_state: dict = field(default_factory=dict)
    #: Greatest ordinal covered, recorded on the cursor for operators. Purely
    #: observability — resumption is driven by ``state``, so a driver must not
    #: treat this as a floor it can read back.
    high_water: Optional[str] = None
    #: True when the provider said "nothing changed" (a 304, an empty update
    #: set). Distinct from an empty ``items`` list, which can also mean
    #: "changed, but everything fell outside the window".
    unchanged: bool = False


class IngestDriver:
    """Base for every provider driver in ``flow_sdk/ingest/drivers/``.

    The optional hooks are class attributes defaulting to ``None``/``False``,
    so the engine reads them directly instead of probing with ``getattr``.
    """

    provider: str
    #: The ontology kind a DataSource using this driver carries. Stamped onto
    #: the row by ``sync_source`` so the driver is the single owner.
    kind: str
    # NOTE: a record-emitting driver also carries `record_kind` — the ontology
    # kind it stamps on each SourceItemSpec, which decides inbox membership. It is
    # deliberately NOT declared here: only the driver that stamps it ever reads
    # it, and listing it made the three filesystem drivers carry an empty stub
    # to satisfy a field the engine never consults.

    #: Whether this source's bytes are OURS to write to. False means indexing
    #: must not stamp an identity capsule into the file — a git working tree is
    #: the clear case, where a stamp dirties the tree, gets committed, and
    #: propagates to everyone who pulls. Such a source resolves identity by
    #: `origin_id` lookup instead. Defaults True, which is what every
    #: workspace-backed type has always done.
    stamps_identity: bool = True

    #: Whether this driver can push a message back to its channel. Discovered
    #: the same way ``channel_for`` is — a driver that cannot send simply omits
    #: ``send`` and leaves this False, and stays a three-line class.
    sends: bool = False
    #: Whether strangers are the POINT of this channel. The agent runner admits
    #: an inbound author only when the source's allowlist names them — empty
    #: admits nobody, which is right for a mailbox holding tools. A help desk
    #: exists to answer people nobody listed, so its driver declares this and an
    #: EMPTY allowlist admits everyone; a non-empty one still restricts.
    open_inbound: bool = False
    #: The config field that names WHICH remote account/feed-set a source of
    #: this provider serves — the natural key a caller (e.g. ``blocks.Inbox``)
    #: matches on to reuse an existing source instead of minting a twin.
    identity_config_key: str = "inbox"
    #: OPTIONAL. The machine-level connection (``flow_sdk.connections``) this
    #: provider reads with, when the credential is NOT in the source's config
    #: (Slack, Google Drive). ``blocks.Inbox`` and the connect flow check it
    #: up front and fail with the fix in the message, instead of letting the
    #: first poll park the source on ``no_credential``.
    connection: Optional[str] = None
    #: OPTIONAL sub-tick cadence while someone is WATCHING a source of this
    #: provider (a `request_poll` stream is arriving): the attention fast lane
    #: polls every this-many seconds instead of waiting for the heartbeat
    #: tick. None — the default — means the provider does not tolerate it and
    #: attention only makes the source due for the next tick. A chat channel
    #: declares a small number (telegram: 5); a rate-limited mailbox does not.
    attention_poll_seconds: Optional[int] = None
    #: Ceiling on segments synced per pass; None means the caller's budget.
    segment_budget: Optional[int] = None

    @classmethod
    def outbound_spec(cls, source) -> type["MessageSpec"]:
        """The spec class that knows WHO a reply on this channel is addressed to.

        ``MessageSpec`` already states the rule — subclasses "own their
        ``reply_to`` constructor, because channels disagree on WHO a reply
        targets: email replies to the author's address, a chat channel replies
        to the chat itself" — and each spec implements it. This attribute is
        how a caller ASKS, instead of re-deriving the rule from the provider
        name.

        Takes the SOURCE, not just the driver, for the same reason
        ``channel_for`` does: one driver can serve several channels.
        ``AgentDriver`` reaches whichever connector its config names, so "which
        channel is this?" is only answerable per source.

        Email is the default because it is the historical behaviour; a
        channel-addressed driver overrides in one line. Imported late: this
        module is imported by ``builtin.data_source``, so a module-level import
        of ``builtin.source_item`` would close a cycle.
        """
        from flow_sdk.builtin.source_item import EmailMessageSpec  # noqa: PLC0415

        return EmailMessageSpec

    #: OPTIONAL identity resolver ``(source, ref) -> origin_id`` for unstamped sources.
    origin_id_for: Optional[Callable[..., str]] = None
    #: OPTIONAL ``(source) -> FSOrigin`` — where the source's tree lives; stamped on save.
    origin_for: Optional[Callable[..., Any]] = None
    #: OPTIONAL targeted reply lookup for transports that can query headers.
    #: This keeps a caller waiting on one response from backfilling an unrelated
    #: mailbox before it can observe that response.
    find_reply: Optional[Callable[..., Any]] = None
    #: OPTIONAL blocking reply lookup. A transport with a durable session can
    #: wait without reconnecting on every probe; the caller still owns the
    #: outer deadline and cancellation.
    wait_for_reply: Optional[Callable[..., Any]] = None

    async def send(
        self,
        source: "DataSource",
        *,
        thread_key: str,
        to: str,
        text: str,
        subject: str = "",
        conversation_id: str = "",
        in_reply_to: str = "",
    ) -> "SendOutcome":
        """OPTIONAL. Push one message into the channel and record it.

        Returns what the channel confirmed. The driver does NOT write the
        record itself — the transport does, through the same
        ``ingest_items`` chokepoint an inbound message uses, so a reply
        re-enters by the front door and needs no outbound code path.

        MUST NOT raise ``SourceError``: that health drives DataSource parking,
        and one failed reply must never stop a mailbox syncing.
        """
        raise NotImplementedError

    #: OPTIONAL. The user-facing CHANNEL this source reaches — gmail | slack | jira.
    channel_for: Optional[Callable[["DataSource"], str]] = None

    #: OPTIONAL. Can this source actually read what it was configured for?
    verify: Optional[Callable[["DataSource"], Any]] = None  # async (source) -> SetupVerdict

    #: OPTIONAL ``(source, field) -> list[Choice]`` — the remote containers this
    #: credential can SEE for ONE config field: buckets, shared drives, channels. It is
    #: what lets the form offer a list instead of asking for an id nobody can produce
    #: from memory. Keyed by field name because one driver may furnish more than one.
    #:
    #: RAISES ``SourceError`` like ``fetch``, rather than returning a verdict like
    #: ``verify``: its return type is a payload with no room for a sentence, and the ONE
    #: caller (``DataSource.choices_for``) turns the raise into the same "empty list plus
    #: one line" every provider needs. Three drivers writing that try/except would be
    #: three chances to word the same refusal differently.
    choices: Optional[Callable[..., Any]] = None

    async def segments(self, source: "DataSource") -> list[SegmentRef]:  # noqa: D102
        """The syncable units of ``source``.

        Async for every driver, not because the nine builtins need it — they
        answer from ``source.config`` — but because a source whose driver is an
        authored module has to SPAWN it to know, and one signature that is true
        for all ten beats nine truths and a special case at the call site.
        """
        raise NotImplementedError

    async def fetch(self, source: "DataSource", cursor: SegmentCursorView) -> FetchResult:
        """Fetch one stream. Raise ``SourceError`` to classify a failure."""
        raise NotImplementedError


def segments_from_config(source: "DataSource", key: str = "channels") -> list[SegmentRef]:
    """The streams a channel-list source names in ``config[key]``.

    Keyed by id, never by name: a renamed channel is the same channel, and
    keying on the name would fork its history. Each entry is either a bare id
    or ``{"id", "name"}`` from the picker.
    """
    config = getattr(source, "config", None) or {}
    entries = config.get(key) or []
    # A `lines` field arrives as a bare string from a caller that bypassed the
    # form (``blocks.Inbox`` names ONE channel); iterating it would yield its
    # characters as ids.
    if isinstance(entries, str):
        entries = [line for line in entries.splitlines() if line.strip()]
    refs: list[SegmentRef] = []
    for entry in entries:
        if isinstance(entry, dict):
            ref_key = str(entry.get("id") or "").strip()
            label = str(entry.get("name") or ref_key)
        else:
            ref_key = str(entry).strip()
            label = ref_key
        if ref_key:
            refs.append(SegmentRef(key=ref_key, label=label))
    return refs


def identity_stamped(source: "DataSource") -> bool:
    """Whether ``source`` already knows which account it reads as."""
    return bool(getattr(source, "account_key", "") or getattr(source, "account_identities", None))


async def stamp_identity(source: "DataSource", *, account_key: str, identities: list[str]) -> None:
    """Record the account a source reads and posts as.

    ``self_addresses`` reads ``account_identities``; without them the inbox
    attributes our own posts to a foreign sender and a ``blocks.Inbox`` loop
    answers itself.
    """
    source.account_key = account_key
    source.account_identities = [v for v in identities if v]
    await source.save()


def channel_of_driver(driver: "IngestDriver", source: "DataSource") -> str:
    """The driver's channel for this source, defaulting to its provider.

    The seam that lets a single-channel driver stay a three-line class while
    the agent transport reads its connector out of config.
    """
    if driver.channel_for is not None:
        try:
            resolved = (driver.channel_for(source) or "").strip()
            if resolved:
                return resolved
        except Exception:
            # Never fail a sync over this — but never hide it either. The
            # channel is half the thread key, so a silently wrong one forks
            # every thread in the mailbox, permanently, while still looking
            # like a successful poll.
            logger.exception("[ingest] channel_for failed for %s; falling back to provider", getattr(source, "id", "?"))
    return str(driver.provider or "")


#: The `context_data` key naming the source a spawned worker belongs to.
#: Paired with `SCOPES["data_source_id"]` (flow_sdk/server/routes/runs.py) and
#: `PROCESS_RUN_SCOPE_KEYS` (ui/src/navigation/DockPointer.ts) — an ingest worker
#: has no spawning entity to browse from, so this key is the only handle the Runs
#: list has on it. One definition on the producing side; the two consumers name
#: it back.
RUN_SOURCE_KEY = "data_source_id"


def ingest_run_context(source: "DataSource") -> dict[str, str]:
    """The provenance every ingest-spawned worker carries."""
    return {RUN_SOURCE_KEY: str(getattr(source, "id", "") or "")}


#: Keyed by ``provider``. A miss answers ``None`` — an unknown provider is a
#: diagnosable source state (``unknown_provider``), not a crash in the poller.
DRIVERS: "KindRegistry[IngestDriver]" = KindRegistry("ingest provider", key="provider")


def register_driver(driver: IngestDriver) -> IngestDriver:
    return DRIVERS.register(driver)


def get_driver(provider: str) -> Optional[IngestDriver]:
    return DRIVERS.get_or_none(provider)
