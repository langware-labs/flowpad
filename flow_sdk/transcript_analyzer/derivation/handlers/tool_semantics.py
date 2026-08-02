"""A generic tool-use becomes a semantic entry — one rule, every worker.

This is the consolidation the layer exists for. Before it, "this tool call was a
search" was written once per parser, so a kind existed only where somebody
remembered to add it: codex produced no ``SearchEntry``, copilot no
``ExitPlanModeEntry``. Neither was a decision.

Covers all ten semantic kinds. The four that ``_fold_tool_results`` indexes
(``shell_command``, ``file_read``, ``file_write``, ``file_edit``) looked like
they needed the fold to change first, since folding runs BEFORE derivation to
attach a tool result to its call. They do not: the fold indexes those kinds, and
a worker that hands us a *generic* tool-use for its shell was never folded in the
first place. So deriving them adds a chip where there was none and takes nothing
away — codex shell commands, which rendered as nameless tool rows, are the case
this closes. Making the fold ALSO index ``TOOL_USE`` would let codex results
attach too; that is an improvement, not a prerequisite.

The handler fires on ``TOOL_USE`` only, so a worker whose parser already emits a
semantic entry directly is untouched — there is no generic tool-use left to
refine, and nothing can double up.
"""

from __future__ import annotations

from typing import Any

from ..._helpers import truncate_file_content
from ...derive import _shell_command_text
from ...entries import (
    AgentSpawnEntry,
    ExitPlanModeEntry,
    FileEditEntry,
    FileReadEntry,
    FileWriteEntry,
    SearchEntry,
    ShellCommandEntry,
    SkillCallEntry,
    TodoUpdateEntry,
    ToolUseEntry,
    WebFetchEntry,
)
from ...entry import EntryKind, TranscriptEntry
from ..registry import ANY_WORKER, register
from ..virtual import virtual_envelope
from .tool_maps import (
    AGENT_SPAWN,
    EXIT_PLAN_MODE,
    FILE_EDIT,
    FILE_READ,
    FILE_WRITE,
    SEARCH,
    SHELL_COMMAND,
    SKILL_CALL,
    TODO_UPDATE,
    WEB_FETCH,
    arg,
    arg_list,
    semantic_key,
)


def _build(key: str, ti: dict, common: dict[str, Any], outcome: dict[str, Any], command: str) -> TranscriptEntry | None:
    if key == SKILL_CALL:
        return SkillCallEntry(skill_name=arg(ti, "skill"), tool_input=ti, **common)
    if key == EXIT_PLAN_MODE:
        return ExitPlanModeEntry(tool_input=ti, **common)
    if key == SEARCH:
        return SearchEntry(
            search_kind=str(common.get("tool_name") or "").lower(),
            query=arg(ti, "query"),
            path=arg(ti, "path") or None,
            **common,
        )
    if key == WEB_FETCH:
        return WebFetchEntry(
            url=arg(ti, "url") or None,
            query=arg(ti, "query") or None,
            prompt=arg(ti, "prompt") or None,
            **common,
        )
    if key == TODO_UPDATE:
        return TodoUpdateEntry(items=arg_list(ti, "todos"), **common)
    if key == AGENT_SPAWN:
        return AgentSpawnEntry(
            agent_type=arg(ti, "agent_type"),
            prompt=arg(ti, "prompt") or None,
            description=arg(ti, "description") or None,
            **common,
        )
    if key == SHELL_COMMAND:
        raw_timeout = ti.get("timeout")
        return ShellCommandEntry(
            command=command,
            timeout=int(raw_timeout) if isinstance(raw_timeout, (int, float)) else None,
            # The outcome is folded onto the PHYSICAL entry before derivation
            # runs, so it has to be carried forward or the chip renders a
            # command that never finished — and every later layer inherits the
            # gap, since each refines the one above it.
            **outcome,
            **common,
        )
    if key == FILE_READ:
        offset, limit = ti.get("offset"), ti.get("limit")
        start = int(offset) if isinstance(offset, (int, float)) else None
        end = start + int(limit) if start is not None and isinstance(limit, (int, float)) else None
        return FileReadEntry(path=arg(ti, "path"), start_line=start, end_line=end, **common)
    if key == FILE_WRITE:
        body = arg(ti, "content") or None
        return FileWriteEntry(
            path=arg(ti, "path"),
            content=truncate_file_content(body),
            bytes_count=len(body.encode("utf-8")) if body else None,
            line_count=body.count("\n") + 1 if body else None,
            is_new=True,
            **common,
        )
    if key == FILE_EDIT:
        return FileEditEntry(path=arg(ti, "path"), hunks=_hunks(ti), **common)
    return None


def _outcome_of(entry: TranscriptEntry) -> dict[str, Any]:
    """Result fields the fold attached to the physical entry, if any."""
    keys = ("cwd", "exit_code", "stdout_preview", "stderr_preview", "duration_ms")
    return {key: value for key in keys if (value := getattr(entry, key, None)) is not None}


def _command_text(ti: dict) -> str:
    """The shell command, however the vendor shaped it.

    Codex passes argv (``["bash", "-lc", "…"]``); the real command is the last
    element. Everyone else passes a string.
    """
    raw = ti.get("command")
    if isinstance(raw, list):
        return str(raw[-1]) if raw else ""
    return str(raw or "")


def _hunks(ti: dict) -> list[dict]:
    """Edit hunks, from either the single-edit or the batched shape."""
    edits = ti.get("edits")
    if isinstance(edits, list):
        return [
            {
                "old": str(e.get("old_string") or e.get("old_str") or ""),
                "new": str(e.get("new_string") or e.get("new_str") or ""),
                "replace_all": bool(e.get("replace_all", False)),
            }
            for e in edits
            if isinstance(e, dict)
        ]
    old, new = arg(ti, "old_string"), arg(ti, "new_string")
    if not old and not new:
        return []
    return [{"old": old, "new": new, "replace_all": bool(ti.get("replace_all", False))}]


def derive_tool_semantics(entry: TranscriptEntry) -> list[TranscriptEntry] | None:
    # Exact type, not isinstance and not ``entry.virtual``. The registry only
    # dispatches ``TOOL_USE``, and ``ExitPlanModeEntry`` is the one semantic
    # class that inherits that kind rather than declaring its own — so it is the
    # only refinement that can arrive here, and it arrives PHYSICALLY (claude's
    # parser emits it), which a ``virtual`` check would wave through into an
    # infinite self-refinement.
    if type(entry) is not ToolUseEntry:
        return None
    tool_name = str(getattr(entry, "tool_name", "") or "")
    key = semantic_key(entry.worker, tool_name)
    if key is None:
        return None

    tool_input = getattr(entry, "tool_input", None)
    ti = tool_input if isinstance(tool_input, dict) else {}

    common: dict[str, Any] = {
        "tool_name": tool_name,
        # Inherited, never suffixed — it is the pairing key the vendor's tool
        # result carries. See ``derivation/virtual.py``.
        "tool_use_id": getattr(entry, "tool_use_id", "") or "",
        **virtual_envelope(entry, key),
    }
    built = _build(key, ti, common, _outcome_of(entry), _shell_command_text(entry) or "")
    return [built] if built is not None else None


def install() -> None:
    register(ANY_WORKER, EntryKind.TOOL_USE, derive_tool_semantics)
