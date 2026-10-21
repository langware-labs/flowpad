"""``SourceItemSpec`` — the ingestion envelope, registered as ``ingest.source_item``.

Lives in the schema layer so ``register_builtin_kinds()`` can import it without
reaching into ``flow_sdk.builtin`` — the kind must be resolvable in a process
that never touched a ``SourceItem`` row, or a dataset spec naming
``ingest.source_item`` silently compiles to ``Any``. ``flow_sdk.builtin.source_item``
re-exports it, so the row and its snapshot still read as one module.
"""
from __future__ import annotations

import re
from typing import Any, ClassVar, Optional

from pydantic import ConfigDict, field_validator, model_validator

from flow_sdk.schema.data_spec._types import NonBlank
from flow_sdk.schema.data_spec.spec import DataSpec, Tagged
from flow_sdk.sources.values.items import Payload
from flow_sdk.sources.values.origin import CloudOrigin

#: Slack's ``ts`` shape and nothing else in the fleet: ten epoch digits, a dot,
#: a fraction. Ten digits pins the range to 2001–2286, and the mandatory
#: fraction excludes every plain numeric id (HackerNews items, Telegram update
#: ids) from ever matching.
_EPOCH_ID = re.compile(r"1\d{9}\.\d+")


class SourceItemSpec(DataSpec):
    """The ingestion envelope — header + body, in the network-message sense.

    What a driver hands the ingestor: a routing **header** (which source, which
    record) plus the normalized **body** it stores. ``raw`` rides
    along uninterpreted so a mapping bug can be re-derived later without
    re-fetching. Field names are the ROW's — this is the type's ``asset_spec``,
    the model that selects which fields the medium persists.

    ``extra="forbid"`` (DataSpec) is the write route's unknown-field refusal: a
    caller that misspelled ``name`` as ``subject`` gets an error, not a row with
    an empty name. Frozen: an envelope is a value.
    """

    spec_kind: ClassVar[str] = "ingest.source_item"
    model_config = ConfigDict(extra="forbid", frozen=True)

    # ── header — each a natural-key component or a route key, so never blank ──
    data_source_id: NonBlank
    provider: NonBlank
    kind: NonBlank
    external_id: NonBlank

    # ── body ──
    name: str = ""
    body: str = ""
    occurred_at: Optional[str] = None

    @model_validator(mode="before")
    @classmethod
    def _scope_when_known(cls, data):
        """``item_scope`` when the envelope already says it: the scope its origin was minted in
        (``Scope.origin``), or ``""`` for an unlifted flat envelope — its lifted origin is scoped by
        the account (or the kind) alone. Left ``None`` only for an origin that lost its scope in
        transit; ``ingestor.lift_page`` recovers that one from the source's account."""
        if isinstance(data, dict) and data.get("item_scope") is None:
            origin = data.get("origin")
            if origin is None:
                data = {**data, "item_scope": ""}
            elif isinstance(origin, CloudOrigin) and origin._scope is not None:
                data = {**data, "item_scope": origin._scope}
        return data

    @model_validator(mode="before")
    @classmethod
    def _epoch_id_is_the_clock(cls, data):
        """When the provider's own id IS a timestamp, it outranks the caller.

        Slack's ``ts`` (``1768957346.733449`` — ten epoch digits, a dot, a
        fraction) doubles as the message id AND its event time. The agent
        transport's worker derives ``occurred_at`` from it BY HAND, and an
        LLM doing timezone arithmetic produced stamps wrong by arbitrary
        half-hours, differently on each refetch (observed live). The epoch is
        deterministic — so it wins, unconditionally: convergent for a correct
        caller (same instant), corrective for a sloppy one, and because
        ``occurred_at`` is digested, a corrected stamp re-ingests as an
        update and re-projects, healing the stream inbox on the next sync.
        """
        if isinstance(data, dict):
            ext = str(data.get("external_id") or "")
            if _EPOCH_ID.fullmatch(ext):
                from flow_sdk.utils.serialization import epoch_to_iso_utc  # noqa: PLC0415

                data = dict(data)
                data["occurred_at"] = epoch_to_iso_utc(float(ext))
        return data

    @field_validator("occurred_at", mode="before")
    @classmethod
    def _canonical_event_time(cls, v):
        """EVENT time normalized ONCE, at the edge, to one canonical form —
        aware-UTC ISO (``+00:00``). Drivers hand us every dialect (``Z``
        suffix, naive, datetime objects) and everything downstream compares
        these as strings (cursor high-water marks, ordering keys), so a mixed
        corpus is a lexicographic landmine. ``occurred_at`` is a DIGESTED
        field: rows stored in another dialect re-digest as *updated* on their
        next sync — a deliberate one-time convergence that also re-projects
        them (healing ``sent_at``). Unparseable input degrades to None, the
        same forgiving contract as ``iso_to_utc``.
        """
        if v is None or v == "":
            return None
        from flow_sdk.utils.serialization import iso_to_utc  # noqa: PLC0415

        parsed = iso_to_utc(v)
        return parsed.isoformat() if parsed is not None else None
    author_external_id: Optional[str] = None
    author_display: Optional[str] = None
    permalink: Optional[str] = None
    thread_key: Optional[str] = None
    reply_to_external_id: Optional[str] = None
    # Adoption hints for a channel whose messages ALREADY exist locally as
    # hub-mirrored rows (the help desk: a ticket is a hub conversation, and
    # after pickup the hub fans its messages out to this machine too). The
    # projection adopts `conversation_id` at thread birth instead of minting,
    # and mints the FlowMessage with `message_id`, so the two writers converge
    # on one row instead of a twin. Absent for every other channel. Neither is
    # digested — they never change for a given record.
    conversation_id: Optional[str] = None
    message_id: Optional[str] = None
    #: Who else the message was addressed to, as the provider printed each one
    #: (``"Ada <ada@x.io>"`` or a bare address). Not digested.
    recipients: list[str] = []
    raw: Optional[dict] = None

    # ── the contract's value, lifted from the header above (``ingest/envelope_lift.py``) ──
    # The ingestor fills both before it resolves the row; a caller may pass them already
    # lifted. ``data`` is the AUTHORITATIVE body: the row stores it as ``payload`` and the change
    # digest is computed over it. The flat header above is its queryable copy until every reader
    # moves to the payload accessors.
    origin: Optional[CloudOrigin] = None
    # Stored under ``data`` until the readers that address it by path (``data.stage`` in mirror
    # maps, dataset files) move with the migration; ``payload`` is the name new code reads.
    data: Optional[Tagged[Payload]] = None
    #: The account-free scope of the item (``flow_sdk.sources.base.scope_of``): with
    #: ``data_source_id`` and ``item_key`` it IS the stored identity. ``None`` until the ingestor
    #: fills it (``ingestor.lift_page``); a caller that knows it passes it.
    item_scope: Optional[str] = None

    @property
    def payload(self) -> Optional[Payload]:
        """The authoritative typed value (stored as ``data``)."""
        return self.data

    @property
    def item_key(self) -> str:
        """The remote id, unique within ``(data_source_id, item_scope)``."""
        return self.origin.key if self.origin is not None else self.external_id

    def digest_view(self) -> dict:
        """What the change digest hashes: the payload — minus the fields its class declares in
        ``digest_exclude`` — its schema, and the link the origin carries. An envelope never lifted
        (no payload) falls back to the flat header's view."""
        if self.data is None:
            return self.legacy_digest_view()
        return {
            "spec_kind": getattr(type(self.data), "spec_kind", None),
            "payload": self.data.stable_dump(),
            "url": self.origin.url if self.origin is not None else None,
        }

    def legacy_digest_view(self) -> dict:
        """The digest rows written before the payload digest carry (``DIGESTED_FIELDS`` plus a
        record's typed fields, a message's mark). The gate accepts it as *unchanged* so the switch
        rewrites nothing; the data migration re-digests every row once."""
        view = {name: getattr(self, name, None) for name in DIGESTED_FIELDS}
        fields = record_fields(self.data)
        if fields is not None:
            view["data"] = fields
        else:
            mark = getattr(self.data, "mark", None)
            if mark is not None:
                view["mark"] = mark.model_dump(mode="json")
        return view

    # The flat triple the legacy natural key reads (``SOURCE_ITEM.legacy_natural_key``).
    @property
    def origin_kind(self) -> str:
        return self.origin.kind if self.origin else ""

    @property
    def origin_namespace(self) -> str:
        return self.origin.namespace if self.origin else ""

    @property
    def origin_key(self) -> str:
        return self.origin.key if self.origin else ""


def record_fields(data: Any) -> Any:
    """A RECORD's own typed fields, as change detection reads them (its ``volatile`` ones left out),
    or None for anything that is not a record (a message, a file: their header says it all)."""
    from flow_sdk.sources.values.items import RecordData  # noqa: PLC0415

    return data.stable_dump() if isinstance(data, RecordData) else None


DIGESTED_FIELDS: tuple[str, ...] = (
    "kind",
    "name",
    "body",
    "occurred_at",
    "author_external_id",
    "author_display",
    "permalink",
    "thread_key",
)
