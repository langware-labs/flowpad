"""``AgentTranscript`` — eager-parsed unified transcript across workers."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import TYPE_CHECKING, Iterator

from .entries import (
    ExitPlanModeEntry,
    FileEditEntry,
    FileReadEntry,
    FileWriteEntry,
    MetaEntry,
    ShellCommandEntry,
    ToolResultEntry,
    ToolUseEntry,
    UserMessageEntry,
)
from .entry import EntryKind, TranscriptEntry
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

logger = logging.getLogger(__name__)


class AgentTranscript:
    """Parsed view of a single agent's transcript JSONL file.

    Construction is eager: the file is read, every line dispatched through
    the worker-specific ``Parser``, and ``self.entries`` is populated. This
    matches v1's static-only scope; live event streams are not handled here.
    """

    def __init__(
        self,
        worker_type: str,
        path: Path | str,
        *,
        session_id: str = "",
    ) -> None:
        self.worker_type = worker_type
        self.path = Path(path)
        parser_cls = get_parser_class(worker_type)
        self._parser = parser_cls(session_id=session_id)
        self.entries: list[TranscriptEntry] = self._parse()

    @property
    def session_id(self) -> str:
        """Session id, resolved from whichever line first carries one."""
        return self._parser.session_id

    # ── parsing ──────────────────────────────────────────────────────────────

    def _parse(self) -> list[TranscriptEntry]:
        out: list[TranscriptEntry] = []
        if not self.path.exists():
            logger.debug("AgentTranscript: file not found at %s", self.path)
            return out
        try:
            with self.path.open("r", encoding="utf-8") as f:
                for idx, line in enumerate(f):
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        raw = json.loads(line)
                    except json.JSONDecodeError:
                        logger.debug(
                            "AgentTranscript: skipping malformed JSONL line %d in %s",
                            idx, self.path,
                        )
                        continue
                    out.extend(self._parser.feed(raw, idx))
        except OSError as exc:
            logger.debug("AgentTranscript: read failed %s: %s", self.path, exc)
        return self._fold_tool_results(out)

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

        kept: list[TranscriptEntry] = []
        for e in entries:
            if not isinstance(e, ToolResultEntry):
                kept.append(e)
                continue
            target = call_index.get(e.tool_use_id) if e.tool_use_id else None
            if target is None:
                # Result belongs to a catch-all tool_use (or has no
                # paired call) — keep as standalone row.
                kept.append(e)
                continue
            output = e.tool_output or ""
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

    @property
    def latest_plan(self) -> ExitPlanModeEntry | None:
        """Most recent ``ExitPlanMode`` tool_use, or None.

        ``latest_tool_use("ExitPlanMode")`` already returns the
        ``ExitPlanModeEntry`` subclass when present (parser-side dispatch
        in ``ClaudeParser._parse_assistant``).
        """
        latest = self.latest_tool_use("ExitPlanMode")
        return latest if isinstance(latest, ExitPlanModeEntry) else None

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
