"""``ProcessCounters`` / ``ProcessStatusReport`` — the generic agent-progress projection.

A running agentic process (visible PTY, headless print-mode, any worker vendor)
exposes one backend-computed snapshot to the UI: how many tokens/messages/tool
calls it has burned so far, which asset it's currently focused on, and its
worker/lifecycle status. This is a **projection** — it never owns state. Token
counts fold out of the already-parsed :class:`UsageEntry` stream; status is read
from the process; the focused asset is derived from the same transcript entries
the plan/markdown chips already inspect.

Kept pure (stdlib + pydantic, no DB/worker) so the fold is provable in a
<15-line test: ``ProcessCounters.from_transcript(AgentTranscriptFile(...))``.

Emission is on the shared ``progress_report`` FlowData envelope — see
``AgenticProcess._flush_transcript_change``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal, Optional

from pydantic import BaseModel

from .entry import EntryKind

if TYPE_CHECKING:
    from .transcript import AgentTranscriptFile


# The `attributes.kind` sub-discriminator that marks a `progress_report`
# FlowData envelope as a process status report (vs. the scan/index progress
# pill). Mirrored on the frontend as `PROCESS_STATUS_KIND` in
# `ts_sdk/src/process/process-status-report.ts` — keep the two in sync.
PROCESS_STATUS_KIND = "process_status"


# Entries carrying a ``tool_use_id`` — exactly one per ``tool_use`` block (the
# parser emits EITHER the catch-all ``ToolUseEntry`` OR one semantic subclass,
# never both), so counting this union never double-counts a single tool call.
_TOOL_KINDS: frozenset[EntryKind] = frozenset({
    EntryKind.TOOL_USE,
    EntryKind.FILE_WRITE,
    EntryKind.FILE_EDIT,
    EntryKind.FILE_READ,
    EntryKind.SHELL_COMMAND,
    EntryKind.SKILL_CALL,
    EntryKind.SEARCH,
    EntryKind.WEB_FETCH,
    EntryKind.TODO_UPDATE,
    EntryKind.AGENT_SPAWN,
})


class ProcessCounters(BaseModel):
    """Running token / message / tool-call totals for one agentic process.

    Extensible: a new counter is one field + one line in :meth:`from_transcript`.

    Token dims mirror the disjoint ``(io, cache)`` key space of
    :class:`UsageEntry` — for Claude the four buckets are mutually exclusive
    partitions of a turn (uncached input / cache-read / cache-write / output),
    so summing per bucket is exact with no overlap. Codex emits per-turn
    *increments* as ``UsageEntry`` (the parser diffs its cumulative totals), so
    the same bucketed sum is correct there too.

    ``reasoning_tokens`` is intentionally absent: Claude folds thinking into
    ``output_tokens`` and the Codex parser discards ``reasoning_output_tokens``
    — neither is recoverable from ``UsageEntry`` without a parser change.
    """

    input_tokens: int = 0        # io=input, cache=none  (uncached prompt)
    output_tokens: int = 0       # io=output             (incl. thinking)
    cache_read_tokens: int = 0   # cache=read
    cache_write_tokens: int = 0  # cache=write (5m + 1h tiers)
    assistant_messages: int = 0
    tool_calls: int = 0

    @property
    def total_tokens(self) -> int:
        return (
            self.input_tokens
            + self.output_tokens
            + self.cache_read_tokens
            + self.cache_write_tokens
        )

    @classmethod
    def from_transcript(cls, t: "AgentTranscriptFile") -> "ProcessCounters":
        """Fold a fully-parsed transcript into exact counters.

        Sums the **post-dedup** ``t.usage`` list (whole file, source order),
        NOT a delta: Claude's keep-last dedup zeroes superseded snapshots in
        place, so re-summing the full list each call is idempotent and immune
        to a ``message.id`` spanning two streamer deltas.
        """
        c = cls()
        for e in t.usage:
            if e.unit != "token":  # request-unit server-tool-use rows aren't tokens
                continue
            if e.io == "output":
                c.output_tokens += e.count
            elif e.cache == "read":
                c.cache_read_tokens += e.count
            elif e.cache == "write":
                c.cache_write_tokens += e.count
            elif e.io == "input":
                c.input_tokens += e.count
        c.assistant_messages = sum(
            1 for e in t.entries if e.kind is EntryKind.ASSISTANT_MESSAGE
        )
        c.tool_calls = sum(1 for e in t.entries if e.kind in _TOOL_KINDS)
        return c


class FocusedAsset(BaseModel):
    """What the process is currently pointing at, in the URL ref grammar.

    ``ref_type`` mirrors ``AssetRoutingMethod`` (``ui/src/navigation/
    asset-doc-types.ts``): ``vfs`` → ``ref_value`` is an abs VFS path
    (``<computeNodeTypeId>/<relPath>``); ``typeid`` → ``ref_value`` is a
    ``<type>-<uuid>`` TypeId. ``asset_type`` resolves its icon via
    ``iconForType`` on the frontend — no glyph is hardcoded here.
    """

    asset_type: str
    ref_type: Literal["vfs", "typeid"]
    ref_value: str


class ProcessStatusReport(BaseModel):
    """One streamed snapshot of an agentic process's progress.

    A projection/DTO composed of four independently-owned producers — it is
    NOT a source of truth for any of them. Serialized into the shared
    ``progress_report`` FlowData envelope (``attributes.kind == "process_status"``).
    """

    counters: ProcessCounters
    focused_asset: Optional[FocusedAsset] = None
    worker_status: str = ""
    process_status: str = ""

    @classmethod
    def from_transcript(
        cls,
        t: "AgentTranscriptFile",
        *,
        worker_status: str = "",
        process_status: str = "",
        focused_asset: Optional[FocusedAsset] = None,
    ) -> "ProcessStatusReport":
        return cls(
            counters=ProcessCounters.from_transcript(t),
            focused_asset=focused_asset,
            worker_status=worker_status,
            process_status=process_status,
        )
