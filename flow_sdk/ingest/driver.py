"""The driver contract — the only place provider knowledge is allowed to live.

A driver answers two questions and nothing else: *which streams does this source
have*, and *what has changed in one stream since we last looked*. It never
writes an entity, never emits an event, never advances a cursor.

**The cursor state it receives is its own.** ``StreamCursorView.state`` is an
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

logger = logging.getLogger(__name__)

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.data_source import DataSource
    from flow_sdk.ingest.models import IngestItem


@dataclass(frozen=True)
class SendOutcome:
    """What the channel confirmed about one send.

    ``external_id`` is the provider's id for the message it created — the same
    namespace an inbound record's ``external_id`` lives in, which is what lets
    the sent copy and any later fetch of it converge on one row.

    ``recorded`` says whether the transport also wrote the SourceItem. False
    means the mail went out but the local copy did not land: the user's message
    IS sent, and re-sending to fix the bookkeeping would mail them twice.
    """

    external_id: str = ""
    thread_key: str = ""
    occurred_at: str = ""
    recorded: bool = False
    #: The message was placed in the channel as a DRAFT for the user to send,
    #: not delivered. Some connectors can compose but not send — the claude.ai
    #: Gmail connector exposes `create_draft` and no send verb at all — and a
    #: draft is a真 outcome, not a failure. The caller must not tell the user
    #: their mail went out.
    drafted: bool = False


@dataclass(frozen=True)
class StreamRef:
    """One syncable unit within a source — a feed URL, a channel."""

    key: str
    label: str = ""


@dataclass(frozen=True)
class StreamCursorView:
    """What a driver is told about where it left off.

    ``window_start`` is the "since last pull" floor, already resolved. Drivers
    apply it as a filter on what they fetched; they do not compute it.
    """

    stream_key: str
    state: dict = field(default_factory=dict)
    window_start: Optional[str] = None
    first_run: bool = True


@dataclass(frozen=True)
class FetchResult:
    """What a driver found, plus the state it wants carried to next time."""

    items: list["IngestItem"] = field(default_factory=list)
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
    #: The ontology kind stamped on each IngestItem. NOTE: this decides inbox
    #: membership — the inbox projection accepts `content.message.*` and
    #: nothing else (`flow_sdk/inbox/projection.py MESSAGE_KIND_ROOT`).
    record_kind: str

    #: Whether this driver can push a message back to its channel. Discovered
    #: the same way ``channel_for`` is — a driver that cannot send simply omits
    #: ``send`` and leaves this False, and stays a three-line class.
    sends: bool = False

    async def send(self, source: "DataSource", *, thread_key: str, to: str,
                   text: str, subject: str = "") -> "SendOutcome":
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

    def streams(self, source: "DataSource") -> list[StreamRef]:
        """The syncable units of ``source``, derived from its config."""
        ...

    async def fetch(self, source: "DataSource", cursor: StreamCursorView) -> FetchResult:
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
            logger.exception("[ingest] channel_for failed for %s; falling back to provider",
                             getattr(source, "id", "?"))
    return str(getattr(driver, "provider", "") or "")


_REGISTRY: dict[str, IngestDriver] = {}


def register_driver(driver: IngestDriver) -> IngestDriver:
    _REGISTRY[driver.provider] = driver
    return driver


def get_driver(provider: str) -> Optional[IngestDriver]:
    return _REGISTRY.get(provider)
