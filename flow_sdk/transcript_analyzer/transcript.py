"""``AgentTranscriptFile`` — eager-parsed unified transcript across workers."""

from __future__ import annotations

import copy
import json
import logging
from pathlib import Path
from typing import TYPE_CHECKING, Iterator

from .derive import derive_entries
from .entries import (
    AssistantMessageEntry,
    FileReadEntry,
    MetaEntry,
    ShellCommandEntry,
    ToolResultEntry,
    ToolUseEntry,
    UsageEntry,
    UserMessageEntry,
)
from .entry import EntryKind, TranscriptEntry
from .formats import TranscriptFormat
from .parsers import get_parser_class

# Outputs longer than this are truncated when folded into a semantic call
# entry. Keeps payloads bounded over the wire — the full output is still
# available on the original ToolResultEntry when the catch-all path is used.
_FOLD_PREVIEW_MAX_CHARS = 4000

# User-message texts that are synthetic (Claude Code injects them on user
# interrupts). They're "user" lines in the JSONL but the human didn't type
# them — drop from the prompts collection.
_SYNTHETIC_USER_TEXTS = frozenset({
    "[Request interrupted by user for tool use]",
})

if TYPE_CHECKING:
    from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData

    from .pricing.base import ModelPricing

logger = logging.getLogger(__name__)


class AgentTranscriptFile:
    """Parsed view of a single agent's transcript JSONL file.

    Construction is eager: the file is read, every line dispatched through
    the worker-specific ``Parser``, and ``self.entries`` is populated.

    Also supports **incremental delta parsing** via ``parse_delta()`` —
    the same parser instance is fed new lines appended to the file since
    the previous call. The retained un-folded buffer keeps folding correct
    across delta boundaries. See ``TranscriptStreamer`` for the runtime
    that consumes this.
    """

    def __init__(
        self,
        worker_type: str,
        path: Path | str,
        *,
        session_id: str = "",
        transcript_format: TranscriptFormat | str | None = None,
    ) -> None:
        self.worker_type = worker_type
        self.path = Path(path)
        self.transcript_format = (
            TranscriptFormat(transcript_format) if transcript_format else None
        )
        parser_cls = get_parser_class(worker_type, self.transcript_format)
        self._parser = parser_cls(session_id=session_id)

        # ── delta state ──
        # Bytes already consumed from the file.
        self._byte_offset: int = 0
        # Monotonic line counter passed to parser.feed(raw, idx).
        self._line_idx: int = 0
        # Pre-fold retained list. Folding spans delta boundaries, so we must
        # refold the FULL list every call — partial folding would lose
        # entries split across two appends (e.g. one assistant message
        # written across multiple JSONL lines sharing entry_id).
        self._unfolded: list[TranscriptEntry] = []
        # Cut index into folded ``self.entries`` for the delta API.
        self._last_emitted: int = 0
        self.entries: list[TranscriptEntry] = []

        # Initial read.
        self._read_and_fold()

    @property
    def session_id(self) -> str:
        """Session id, resolved from whichever line first carries one."""
        return self._parser.session_id

    # ── parsing ──────────────────────────────────────────────────────────────

    def _read_and_fold(self) -> list[TranscriptEntry]:
        """Read new bytes from ``_byte_offset`` to last newline, feed parser,
        append to ``_unfolded``, refold full retained list, set ``self.entries``.

        Trailing incomplete line (no final ``\\n``) is buffered until the next
        call. Truncate/rewrite resets state and re-parses from offset 0.
        """
        if not self.path.exists():
            return self.entries

        # Whole-document workers (e.g. workflow run journals) are a single JSON
        # object, not JSONL — read the file once and feed the parsed object.
        if getattr(self._parser, "whole_document", False):
            return self._read_whole_document()

        try:
            file_size = self.path.stat().st_size
        except OSError as exc:
            logger.debug("AgentTranscriptFile: stat failed %s: %s", self.path, exc)
            return self.entries

        # Truncate / rewrite — file shrank. Reset everything.
        if file_size < self._byte_offset:
            self._reset_state()

        try:
            with self.path.open("rb") as f:
                f.seek(self._byte_offset)
                new_bytes = f.read()
        except OSError as exc:
            logger.debug("AgentTranscriptFile: read failed %s: %s", self.path, exc)
            return self.entries

        if not new_bytes:
            return self.entries

        # Partial-line buffering: consume only up to the last complete line.
        last_newline = new_bytes.rfind(b"\n")
        if last_newline == -1:
            # No complete line yet — defer until next call.
            return self.entries
        complete_part = new_bytes[: last_newline + 1]
        self._byte_offset += len(complete_part)

        for raw_line in complete_part.decode("utf-8", errors="replace").splitlines():
            line = raw_line.strip()
            if not line:
                continue
            try:
                raw = json.loads(line)
            except json.JSONDecodeError:
                logger.debug(
                    "AgentTranscriptFile: skipping malformed JSONL line %d in %s",
                    self._line_idx, self.path,
                )
                self._line_idx += 1
                continue
            self._unfolded.extend(self._parser.feed(raw, self._line_idx))
            self._line_idx += 1

        # Refold the FULL retained list — folds may span delta boundaries.
        # Both fold passes mutate the survivor entry in place (assistant_messages
        # joins `.text`/`.thinking`; tool_results writes ``stdout_preview`` /
        # ``content_preview`` / ``exit_code`` / etc. on the call entry). With
        # repeated folds (one per delta), an in-place mutation from an earlier
        # fold would feed back into the next fold's input — producing duplicated
        # joined text and other re-mutation artifacts. We fold over shallow
        # copies so ``self._unfolded`` stays pristine across delta boundaries.
        return self._refold()

    def _refold(self) -> list[TranscriptEntry]:
        """Refold ``self._unfolded`` (over shallow copies, so the retained list
        stays pristine across delta boundaries) into ``self.entries``."""
        snapshot = [copy.copy(e) for e in self._unfolded]
        folded = self._fold_assistant_messages(snapshot)
        # Derivation runs LAST, after tool results have been folded in, so a
        # derived entry (e.g. FlowCommandEntry) inherits exit_code/stdout.
        self.entries = derive_entries(self._fold_tool_results(folded))
        return self.entries

    def _read_whole_document(self) -> list[TranscriptEntry]:
        """Single-JSON-document path: read the entire file, parse it once, and
        feed the parsed object to the (whole-document) parser. Re-parses only when
        the file size changes since the last read (``_byte_offset`` doubles as the
        last-seen size sentinel here). Used for workflow run journals.
        """
        try:
            file_size = self.path.stat().st_size
        except OSError as exc:
            logger.debug("AgentTranscriptFile: stat failed %s: %s", self.path, exc)
            return self.entries
        if self.entries and file_size == self._byte_offset:
            return self.entries  # unchanged — idempotent
        try:
            text = self.path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            logger.debug("AgentTranscriptFile: read failed %s: %s", self.path, exc)
            return self.entries
        try:
            obj = json.loads(text)
        except json.JSONDecodeError:
            logger.debug("AgentTranscriptFile: malformed JSON document %s", self.path)
            return self.entries
        self._unfolded = list(self._parser.feed(obj, 0))
        self._byte_offset = file_size
        return self._refold()

    def _reset_state(self) -> None:
        """Reset delta state + parser; preserves the resolved session_id so the
        parser doesn't lose it on truncate/rewrite. Used by truncate detection
        and ``force_reparse``."""
        session_id = self._parser.session_id
        parser_cls = get_parser_class(self.worker_type, self.transcript_format)
        self._parser = parser_cls(session_id=session_id)
        self._byte_offset = 0
        self._line_idx = 0
        self._unfolded = []
        self._last_emitted = 0
        self.entries = []

    def parse_delta(self) -> list[TranscriptEntry]:
        """Read new bytes since the previous call and return only entries
        appended since the previous call.

        Idempotent within the same offset state — calling repeatedly without
        new file content returns []. After ``__init__``, the constructor's
        initial read counts as "unseen" until the first ``parse_delta`` call,
        which returns ALL entries. The streamer uses this to flush history
        to subscribers on first notification.
        """
        previous_count = self._last_emitted
        self._read_and_fold()
        new_only = self.entries[previous_count:]
        self._last_emitted = len(self.entries)
        return new_only

    def force_reparse(self) -> None:
        """Reset offset/state to 0 and re-read the full file. Next ``parse_delta``
        re-emits the entire history. Debug knob; used by ``streamer.force_reparse``.
        """
        self._reset_state()
        self._read_and_fold()

    @staticmethod
    def _fold_assistant_messages(
        entries: list[TranscriptEntry],
    ) -> list[TranscriptEntry]:
        """Merge same-entry_id AssistantMessageEntry rows (Claude writes one
        line per content block sharing the same message.id). Semantic tool
        entries keep their own row.
        """
        groups: dict[str, list[AssistantMessageEntry]] = {}
        for e in entries:
            if not isinstance(e, AssistantMessageEntry) or not e.entry_id:
                continue
            groups.setdefault(e.entry_id, []).append(e)

        if not any(len(g) > 1 for g in groups.values()):
            return entries

        dropped_ids: set[int] = set()
        for grp in groups.values():
            if len(grp) <= 1:
                continue
            survivor = grp[0]
            texts: list[str] = [survivor.text] if survivor.text else []
            thinkings: list[str] = [survivor.thinking] if survivor.thinking else []
            for extra in grp[1:]:
                if extra.text:
                    texts.append(extra.text)
                if extra.thinking:
                    thinkings.append(extra.thinking)
                dropped_ids.add(id(extra))
            survivor.text = "\n".join(texts) if texts else ""
            survivor.thinking = "\n".join(thinkings) if thinkings else None

        return [e for e in entries if id(e) not in dropped_ids]

    @staticmethod
    def _fold_tool_results(entries: list[TranscriptEntry]) -> list[TranscriptEntry]:
        """Fold ``ToolResultEntry`` payloads into the matching semantic call.

        Pairs by ``tool_use_id``. When a result matches a semantic kind
        (``shell_command``, ``file_read``, ``file_write``, ``file_edit``)
        the result is dropped from the timeline and its data folded into
        the call entry — yielding one row per agent operation.

        Catch-all ``ToolUseEntry`` results are left untouched so MCP /
        unknown tool flows keep rendering their result row separately
        (the renderer for those kinds doesn't know how to surface a
        folded result yet).
        """
        # Index semantic call entries by tool_use_id. Multiple call rows
        # can share an id (codex apply_patch with N file ops); fold into
        # the first one only — the rest carry no result data.
        call_index: dict[str, TranscriptEntry] = {}
        for e in entries:
            tuid = getattr(e, "tool_use_id", None)
            if not tuid:
                continue
            kind = e.kind
            if kind not in (
                EntryKind.SHELL_COMMAND,
                EntryKind.FILE_READ,
                EntryKind.FILE_WRITE,
                EntryKind.FILE_EDIT,
            ):
                continue
            if tuid in call_index:
                continue
            call_index[tuid] = e

        # Transport mirrors (codex ``event_msg.patch_apply_end``) duplicate a
        # canonical result under the same tool_use_id. Drop a mirror whenever
        # the canonical (non-mirror) result exists anywhere in the list —
        # folding runs over the FULL retained list, so this pairing works
        # across delta boundaries regardless of write order. A mirror whose
        # canonical line never arrived (turn killed between the two writes)
        # survives as the durable result frame.
        canonical_result_ids = {
            e.tool_use_id
            for e in entries
            if isinstance(e, ToolResultEntry) and e.tool_use_id and not e.is_transport_mirror
        }

        kept: list[TranscriptEntry] = []
        for e in entries:
            if not isinstance(e, ToolResultEntry):
                kept.append(e)
                continue
            if e.is_transport_mirror and e.tool_use_id in canonical_result_ids:
                continue
            target = call_index.get(e.tool_use_id) if e.tool_use_id else None
            if target is None:
                # Result belongs to a catch-all tool_use (or has no
                # paired call) — keep as standalone row.
                kept.append(e)
                continue
            output = e.tool_output or ""
            # Preserve the result's error flag on the surviving call entry —
            # modern Claude Bash results carry no exitCode, only the block's
            # is_error, so dropping the row would lose the failure signal.
            if e.is_error and not getattr(target, "is_error", False):
                target.is_error = True
            if isinstance(target, ShellCommandEntry):
                if target.exit_code is None and e.exit_code is not None:
                    target.exit_code = e.exit_code
                if target.duration_ms is None and e.duration_ms is not None:
                    target.duration_ms = e.duration_ms
                if target.stdout_preview is None and output:
                    target.stdout_preview = output[:_FOLD_PREVIEW_MAX_CHARS]
            elif isinstance(target, FileReadEntry):
                if target.bytes_count is None and output:
                    target.bytes_count = len(output.encode("utf-8"))
                if target.content_preview is None and output:
                    target.content_preview = output[:_FOLD_PREVIEW_MAX_CHARS]
            # FileWriteEntry / FileEditEntry: result is usually a one-line
            # "Updated …" — no field worth surfacing. Result row is dropped.
        return kept

    # ── access ───────────────────────────────────────────────────────────────

    def __iter__(self) -> Iterator[TranscriptEntry]:
        return iter(self.entries)

    def __len__(self) -> int:
        return len(self.entries)

    def walk(self) -> Iterator[TranscriptEntry]:
        """Depth-first over top-level entries AND nested sub-agent children.

        Identical to flat iteration unless the transcript was assembled
        (:func:`flow_sdk.transcript_analyzer.assembly.assemble_tree`), which
        stitches each spawned sub-agent's entries onto
        ``AgentSpawnEntry.children``. A shared ``id()`` guard (in
        ``TranscriptEntry.walk``) makes a malformed cycle terminate.
        """
        seen: set[int] = set()
        for e in self.entries:
            yield from e.walk(seen)

    def filter(
        self,
        *,
        kind: EntryKind | None = None,
        tool_name: str | None = None,
    ) -> Iterator[TranscriptEntry]:
        """Yield entries matching all provided filters.

        ``tool_name`` matches any parsed entry that carries a tool name,
        including semantic operation entries such as ``shell_command``.
        Pass both filters together to combine — they're AND-ed.
        """
        for e in self.entries:
            if kind is not None and e.kind is not kind:
                continue
            if tool_name is not None:
                entry_tool_name = getattr(e, "tool_name", None)
                if entry_tool_name is None:
                    continue
                if entry_tool_name != tool_name:
                    continue
            yield e

    def latest_tool_use(self, tool_name: str) -> ToolUseEntry | None:
        """Return the most recent ``ToolUseEntry`` whose ``tool_name`` matches.

        Reverse-iterates ``entries`` so the first match wins. Returns the
        actual subclass instance (e.g. ``ExitPlanModeEntry`` for
        ``tool_name="ExitPlanMode"``) when applicable.
        """
        for e in reversed(self.entries):
            if isinstance(e, ToolUseEntry) and e.tool_name == tool_name:
                return e
        return None

    @property
    def prompts(self) -> list[UserMessageEntry]:
        """User-typed prompts in chronological order.

        Filters: drop sub-agent (``is_sidechain``) lines, drop empty/
        whitespace-only text, drop Claude Code's synthetic
        ``[Request interrupted by user for tool use]`` marker. Slash
        commands and Flowpad-injected prompts are kept — they're
        user-equivalent actions.
        """
        out: list[UserMessageEntry] = []
        for e in self.entries:
            if not isinstance(e, UserMessageEntry):
                continue
            if e.is_sidechain:
                continue
            text = (e.text or "").strip()
            if not text or text in _SYNTHETIC_USER_TEXTS:
                continue
            out.append(e)
        return out

    # ── cost / usage ─────────────────────────────────────────────────────────

    @property
    def usage(self) -> list[UsageEntry]:
        """Top-level (this file's) per-dim usage entries, in source order.

        Deliberately SHALLOW — it backs span attribution
        (:meth:`usage_in_span`) and per-lane cost, which must charge each lane
        only its own usage. For a whole-session total that includes stitched
        sub-agents, use :meth:`cost_deep` / :meth:`usage_deep`.

        Each entry represents one chargeable stream (tokens or requests)
        from a single assistant turn — see :class:`UsageEntry`. Pairing
        with :mod:`flow_sdk.transcript_analyzer.pricing` gives USD cost
        without losing per-stream detail (cache_read vs cache_write_1h
        vs server_tool_use are all separately matchable).
        """
        return [e for e in self.entries if isinstance(e, UsageEntry)]

    def usage_deep(self) -> list[UsageEntry]:
        """Usage entries across the whole assembled tree (incl. sub-agents).

        Each sub-agent file's usage was de-duplicated by its own parser
        (keep-last by message.id, per-file); we never re-dedup across files,
        so concatenating is correct and never double-counts.
        """
        return [e for e in self.walk() if isinstance(e, UsageEntry)]

    def _sum_cost(
        self,
        entries: Iterator[UsageEntry] | list[UsageEntry],
        pricing: dict[str, "ModelPricing"] | None,
    ) -> float:
        """Sum USD cost of ``entries``, resolving per-entry pricing by model."""
        from .pricing import pricing_for as _pricing_for

        total = 0.0
        for e in entries:
            table = pricing[e.model] if (pricing and e.model in pricing) else _pricing_for(e.model, self.worker_type)
            total += table.cost_of(e)
        return total

    def cost(self, pricing: dict[str, "ModelPricing"] | None = None) -> float:
        """Sum USD cost of this file's own usage (SHALLOW — no sub-agents).

        Mirrors :attr:`usage`; for the whole-session total use :meth:`cost_deep`.
        Per-entry pricing is resolved by ``entry.model``; the optional ``pricing``
        arg overrides the default lookup.
        """
        return self._sum_cost(self.usage, pricing)

    def cost_deep(self, pricing: dict[str, "ModelPricing"] | None = None) -> float:
        """Whole-session cost including every stitched sub-agent (see :meth:`usage_deep`)."""
        return self._sum_cost(self.usage_deep(), pricing)

    def usage_in_span(self, enter_ts: str, done_ts: str) -> list[UsageEntry]:
        """Usage entries whose ``timestamp`` falls in ``[enter_ts, done_ts]``.

        Mirrors the workflow-anchor pairing that ``session_analysis`` uses
        for tool_calls — so an analysis pass can attribute per-step cost
        the same way it already attributes per-step tool usage. Inclusive
        on both bounds; string compare works because Claude / Codex emit
        ISO-8601 timestamps with Z suffix.
        """
        return [e for e in self.usage if e.timestamp and enter_ts <= e.timestamp <= done_ts]

    def cost_in_span(
        self,
        enter_ts: str,
        done_ts: str,
        pricing: dict[str, "ModelPricing"] | None = None,
    ) -> float:
        """USD cost for usage entries within the time span. See :meth:`usage_in_span`."""
        return self._sum_cost(self.usage_in_span(enter_ts, done_ts), pricing)

    @property
    def latest_plan(self) -> ToolUseEntry | None:
        """Most recent ``ExitPlanModeEntry`` across workers, or None.

        Both Claude and Codex emit ``ExitPlanModeEntry`` (Codex synthesized
        from its ``<proposed_plan>`` marker by the Codex parser). The Codex
        TODO-checklist tool (``update_plan``) is intentionally NOT matched
        here — per Codex's own developer prompt it is unrelated to Plan Mode.

        Used by ``AgenticProcess._transcript_plan`` to drive the UI's
        "Open last plan" button uniformly across workers.
        """
        for entry in reversed(self.entries):
            if not isinstance(entry, ToolUseEntry):
                continue
            if entry.tool_name == "ExitPlanMode":
                return entry
        return None

    def to_flow_data(self) -> list["FlowData"]:
        """Concatenated ``FlowData`` stream from every entry."""
        return [fd for e in self.entries for fd in e.to_flow_data()]

    # ── string rendering ─────────────────────────────────────────────────────

    def to_string(self) -> str:
        """Human-readable rendering of every entry, in order.

        Header summarizes worker, session id, path, entry count, and any
        first-class fields surfaced from the leading ``session_meta`` line
        (codex: cwd, git, cli_version, originator, model_provider). Each
        entry is rendered via :meth:`TranscriptEntry.to_string` and joined
        by a blank line for skim-readability.
        """
        header_lines: list[str] = [
            f"# Transcript ({self.worker_type}) — {len(self.entries)} entries",
            f"# session_id: {self.session_id or '<unknown>'}",
            f"# path: {self.path}",
        ]
        meta = self._session_meta_payload()
        if meta:
            for label, key in (
                ("cwd", "cwd"),
                ("cli_version", "cli_version"),
                ("originator", "originator"),
                ("model_provider", "model_provider"),
            ):
                v = meta.get(key)
                if v:
                    header_lines.append(f"# {label}: {v}")
            git = meta.get("git") if isinstance(meta.get("git"), dict) else None
            if isinstance(git, dict):
                for label, key in (
                    ("git.branch", "branch"),
                    ("git.commit", "commit_hash"),
                    ("git.repo", "repository_url"),
                ):
                    v = git.get(key)
                    if v:
                        header_lines.append(f"# {label}: {v}")
        bodies = [e.to_string() for e in self.entries]
        return "\n\n".join(["\n".join(header_lines), *bodies])

    def _session_meta_payload(self) -> dict | None:
        """Locate the leading ``session_meta`` MetaEntry and return its payload.

        Returns ``None`` for transcripts that don't have one (claude
        rollouts, codex stream-event shape).
        """
        for e in self.entries[:5]:
            if isinstance(e, MetaEntry) and e.meta_kind == "session_meta":
                return e.payload
        return None
