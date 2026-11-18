"""What the host's machine did to answer a prompt request — the part that is sent back.

Rides the reply as a ``prompt_run_summary-<completion id>`` TYPE_ID attachment whose
``prompt_preview`` (a hub-known field) holds the value, like a process call's answer.
It names the tools the run used and the files it touched, and nothing else: no tool
input, no tool output, no file content, no path outside the folder the run ran in.
The transcript itself stays on the host.
"""

from functools import cache
from pathlib import PurePath
from typing import Any, ClassVar, Optional

from flow_sdk.schema.data_spec.spec import DataSpec

PROMPT_RUN_SUMMARY_TYPE = "prompt_run_summary"
#: A header value, not a body: a long run is cut here and ``more`` says how much was left out.
MAX_STEPS = 100



@cache
def _kinds() -> tuple[Any, frozenset, frozenset, frozenset]:
    """``(EntryKind, file kinds, changing kinds, step kinds)``. Read on first use: this module
    is a registered kind, loaded wherever the schema registry is (the scan child included),
    and the transcript package is not."""
    from flow_sdk.transcript_analyzer.entry import EntryKind  # noqa: PLC0415

    file_kinds = frozenset({EntryKind.FILE_WRITE, EntryKind.FILE_EDIT, EntryKind.FILE_READ})
    changing_kinds = frozenset({EntryKind.FILE_WRITE, EntryKind.FILE_EDIT})
    # The steps of a run. A tool's result is the same step; a todo update is bookkeeping.
    step_kinds = file_kinds | {
        EntryKind.TOOL_USE,
        EntryKind.SHELL_COMMAND,
        EntryKind.FLOW_COMMAND,
        EntryKind.SKILL_CALL,
        EntryKind.SEARCH,
        EntryKind.WEB_FETCH,
        EntryKind.AGENT_SPAWN,
    }
    return EntryKind, file_kinds, changing_kinds, step_kinds


class PromptRunStep(DataSpec):
    """One thing the run did: the tool, and for a file tool the file."""

    tool: str
    #: Relative to the folder the run ran in; a file outside it is named by its file name only.
    path: Optional[str] = None


class PromptRunSummary(DataSpec):
    spec_kind: ClassVar[str] = "prompt.run_summary"

    steps: list[PromptRunStep] = []
    #: Files the run wrote or edited, each once.
    files_touched: list[str] = []
    #: Steps past ``MAX_STEPS`` that are not listed.
    more: int = 0


def _shown_path(path: str, root: Optional[str]) -> str:
    p = PurePath(path)
    if root and p.is_absolute():
        try:
            return p.relative_to(root).as_posix()
        except ValueError:
            return p.name
    return p.name if p.is_absolute() else p.as_posix()


def summarize_last_turn(entries: Any, *, root: Optional[str]) -> PromptRunSummary:
    """The summary of the LAST turn, from typed transcript entries — the same backwards
    walk as the reply capture: it stops at the prompt that opened the turn."""
    EntryKind, _FILE_KINDS, _CHANGING_KINDS, _STEP_KINDS = _kinds()
    steps: list[PromptRunStep] = []
    files: list[str] = []
    seen: set[str] = set()
    for entry in reversed(list(entries)):
        kind = getattr(entry, "kind", None)
        if kind is EntryKind.USER_MESSAGE and not getattr(entry, "is_meta", False):
            break
        if kind not in _STEP_KINDS or getattr(entry, "virtual", False):
            continue  # a derived entry restates its source: the source is the step
        key = getattr(entry, "tool_use_id", "") or getattr(entry, "id", None)
        if key:
            if key in seen:
                continue  # a streamed line and its final copy are one step
            seen.add(key)
        raw = getattr(entry, "path", None) if kind in _FILE_KINDS else None
        path = _shown_path(str(raw), root) if raw else None
        steps.append(PromptRunStep(tool=getattr(entry, "tool_name", "") or kind.value, path=path))
        if path and kind in _CHANGING_KINDS and path not in files:
            files.append(path)
    steps.reverse()
    files.reverse()
    return PromptRunSummary(steps=steps[:MAX_STEPS], files_touched=files, more=max(0, len(steps) - MAX_STEPS))


def summary_attachment(completion_id: str, summary: PromptRunSummary) -> dict:
    from flow_sdk.builtin.flow_message import value_attachment  # noqa: PLC0415 — builtin imports data_spec

    return value_attachment(PROMPT_RUN_SUMMARY_TYPE, completion_id, summary.model_dump(mode="json", exclude_defaults=True))
