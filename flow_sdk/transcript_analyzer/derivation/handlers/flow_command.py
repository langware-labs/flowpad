"""``flow`` CLI invocations — one rule, every worker.

A ``flow`` call is not a distinct tool; it is a shell command whose text happens
to invoke our CLI. Recognising it from the parsed entry rather than the raw
event is what lets all three workers share the rule: claude hands us a
``ShellCommandEntry``, codex a ``ToolUseEntry(tool_name="shell")`` with an argv
list, copilot a ``ToolUseEntry(tool_name="bash")`` with a string, and the shared
``_shell_command_text`` normalises all three.
"""

from __future__ import annotations

# The shared shell/flow parsing primitives stay where they were — this layer
# adds the *policy* (what becomes an entry), not the lexing.
from ...derive import _shell_command_text, parse_flow_invocation
from ...entries import FlowCommandEntry
from ...entry import EntryKind, TranscriptEntry
from ..registry import ANY_WORKER, register
from ..virtual import shell_fields, virtual_envelope


def derive_flow_command(entry: TranscriptEntry) -> list[TranscriptEntry] | None:
    command = _shell_command_text(entry)
    if not command:
        return None
    parsed = parse_flow_invocation(command)
    if parsed is None:
        return None

    fields = shell_fields(entry)
    # The normalised text, not whatever shape the vendor handed us (codex sends
    # an argv list, or the whole thing wrapped in `/bin/zsh -lc '…'`).
    fields["command"] = command

    return [
        FlowCommandEntry(
            verb=parsed["verb"],
            subverb=parsed["subverb"],
            target=parsed["target"],
            flow_args=parsed["args"],
            **fields,
            **virtual_envelope(entry, "flow_command"),
        )
    ]


def install() -> None:
    # SHELL_COMMAND only — deliberately NOT TOOL_USE. A worker whose parser
    # hands us a generic tool-use for its shell (codex) gets a ShellCommandEntry
    # from the tool-semantics handler first, and this refines THAT. Registering
    # on both would fire twice against the same physical entry and produce two
    # sibling chips instead of one chain.
    register(ANY_WORKER, EntryKind.SHELL_COMMAND, derive_flow_command)
