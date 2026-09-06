"""``SourceItemSpec`` — the ingestion envelope, registered as ``ingest.source_item``.

Lives in the schema layer so ``register_builtin_kinds()`` can import it without
reaching into ``flow_sdk.builtin`` — the kind must be resolvable in a process
that never touched a ``SourceItem`` row, or a dataset spec naming
``ingest.source_item`` silently compiles to ``Any``. ``flow_sdk.builtin.source_item``
re-exports it, so the row and its snapshot still read as one module.
"""
from __future__ import annotations

import re
from typing import Annotated, ClassVar, Optional

from pydantic import ConfigDict, StringConstraints, field_validator, model_validator

from flow_sdk.schema.data_spec.spec import DataSpec

#: A header component: the natural key is ``(data_source_id, segment_key,
#: external_id)`` and a blank component collapses every item of a segment onto
#: one row — so blankness is refused by the type, not by a route.
NonBlank = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]

#: Slack's ``ts`` shape and nothing else in the fleet: ten epoch digits, a dot,
#: a fraction. Ten digits pins the range to 2001–2286, and the mandatory
#: fraction excludes every plain numeric id (HackerNews items, Telegram update
#: ids) from ever matching.
_EPOCH_ID = re.compile(r"1\d{9}\.\d+")


class SourceItemSpec(DataSpec):
    """The ingestion envelope — header + body, in the network-message sense.

    What a driver hands the ingestor: a routing **header** (which source, which
    segment, which record) plus the normalized **body** it stores. ``raw`` rides
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
    segment_key: NonBlank
    external_id: NonBlank

    # ── body ──
    name: str = ""
    body: str = ""
    occurred_at: Optional[str] = None

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
        update and re-projects, healing the inbox on the next sync.
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
    segment_label: str = ""
    raw: Optional[dict] = None
