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
and the next provider will need a special case. ``test_cursor_state_is_opaque``
greps for exactly that.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Optional, Protocol

from flow_sdk._compat import StrEnum

logger = logging.getLogger(__name__)

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.data_source import DataSource
    from flow_sdk.ingest.models import IngestItem


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
    """One syncable unit within a source — a feed URL, a channel."""

    key: str
    label: str = ""


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

    items: list["IngestItem"] = field(default_factory=list)
    #: Asset ROOTS that changed, for drivers whose payload is already local and
    #: whose destination is the filesystem rather than a ``SourceItem`` — the
    #: folder driver today. A path here is the asset root in the sense
    #: ``FSOrigin.rel_path`` already means: a FOLDER for folder-layout types, a
    #: FILE for file-layout ones.
    #:
    #: Deliberately separate from ``items`` rather than a variant of it. Reading
    #: a file's bytes into an ``IngestItem`` only to write them straight back to
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


class IngestDriver(Protocol):
    """Implemented once per provider, in ``flow_sdk/ingest/drivers/``.

    Structural, never subclassed — it documents the contract and types the
    registry. Deliberately not ``runtime_checkable``: that would only compare
    method *names*, which almost anything passes, and would read as a
    validation guarantee that registration does not actually make.
    """

    provider: str
    #: The ontology kind a DataSource using this driver carries. Stamped onto
    #: the row by ``sync_source`` so the driver is the single owner.
    kind: str
    # NOTE: a record-emitting driver also carries `record_kind` — the ontology
    # kind it stamps on each IngestItem, which decides inbox membership. It is
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
        ...

    def channel_for(self, source: "DataSource") -> str:
        """OPTIONAL. The user-facing CHANNEL this source reaches — gmail | slack | jira.

        Distinct from ``provider``, which is the transport: one driver can
        reach several channels (the agent transport does), and one channel can
        be reached by several drivers (a harness Gmail source and an API one).
        The message badge and the thread key both key on the channel, so the
        two transports resolve to the SAME thread.

        Optional. Drivers that are their own channel (rss, hackernews) inherit
        the default in ``channel_of_driver``.
        """
        ...

    async def verify(self, source: "DataSource") -> "SetupVerdict":
        """OPTIONAL. Can this source actually read what it was configured for?

        Distinct from health, which is about whether the LAST run worked. This
        answers "is the setup finished" — and for several providers that is a
        step only a human can take. Slack will not let an app read a channel the
        bot was never invited to, and no amount of correct configuration on our
        side changes that.

        A driver that omits this needs no setup beyond its config, and its
        sources go straight to ACTIVE.
        """
        ...

    async def segments(self, source: "DataSource") -> list[SegmentRef]:
        """The syncable units of ``source``.

        Async for every driver, not because the nine builtins need it — they
        answer from ``source.config`` — but because a source whose driver is an
        authored module has to SPAWN it to know, and one signature that is true
        for all ten beats nine truths and a special case at the call site.
        """
        ...

    async def fetch(self, source: "DataSource", cursor: SegmentCursorView) -> FetchResult:
        """Fetch one stream. Raise ``SourceError`` to classify a failure."""
        ...


def channel_of_driver(driver: "IngestDriver", source: "DataSource") -> str:
    """The driver's channel for this source, defaulting to its provider.

    The seam that lets a single-channel driver stay a three-line class while
    the agent transport reads its connector out of config.
    """
    resolver = getattr(driver, "channel_for", None)
    if callable(resolver):
        try:
            resolved = (resolver(source) or "").strip()
            if resolved:
                return resolved
        except Exception:
            # Never fail a sync over this — but never hide it either. The
            # channel is half the thread key, so a silently wrong one forks
            # every thread in the mailbox, permanently, while still looking
            # like a successful poll.
            logger.exception("[ingest] channel_for failed for %s; falling back to provider", getattr(source, "id", "?"))
    return str(getattr(driver, "provider", "") or "")


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


_REGISTRY: dict[str, IngestDriver] = {}


def register_driver(driver: IngestDriver) -> IngestDriver:
    _REGISTRY[driver.provider] = driver
    return driver


def get_driver(provider: str) -> Optional[IngestDriver]:
    return _REGISTRY.get(provider)
