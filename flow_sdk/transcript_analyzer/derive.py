"""Derived entries — refinements computed FROM already-parsed entries.

A parser's job is to turn a worker's raw transcript line into the closest
typed entry it can. Some semantics only become visible one level up: a
``flow`` CLI call is not a distinct tool, it is a *shell command whose text
happens to invoke the Flowpad CLI*. Deriving it here — worker-agnostically,
from the parsed entry rather than from the raw event — means all three
parsers get it for free and there is exactly one rule to test.

Two seams call this:

* history — ``AgentTranscriptFile._refold`` (runs on every delta too);
* live — the per-worker ``event_to_flowdata`` converters.

Derivation must stay **pure and idempotent**: re-deriving an already-derived
entry returns it unchanged, so a refold over the full retained list never
compounds.
"""

from __future__ import annotations

import shlex
from typing import Any, Iterable

from .entries import FlowCommandEntry, ShellCommandEntry, ToolUseEntry
from .entry import TranscriptEntry

# Tool names that carry a raw shell command in ``tool_input['command']``.
# Public: the Copilot parser shares this list so "what counts as a shell
# tool" is defined once.
# Claude's ``Bash`` is already a ShellCommandEntry by the time we see it;
# Codex (``shell``) and Copilot (``bash``) arrive as generic tool uses.
SHELL_TOOL_NAMES = frozenset({"bash", "shell", "run_command", "exec_command", "terminal"})

# Registered top-level `flow` commands (flow_sdk/cli/flow_cli.py). An unknown
# verb does NOT derive — better a generic shell chip than a bogus flow chip.
_FLOW_VERBS = frozenset({
    "app", "auth", "compute", "config", "context", "conversation", "diagnose",
    "hooks", "instance", "log", "migrate", "navigate", "ping", "process",
    "prompt", "record", "schema", "setup", "show", "start", "status", "stop",
    "tag", "trace", "upgrade", "uninstall", "wizard",
})

# Sub-commands whose first positional argument is the thing being addressed —
# the UI turns that into a clickable target.
_TARGETED = frozenset({"entity", "file", "asset", "record", "url", "webapp"})


def derive_entry(entry: TranscriptEntry) -> TranscriptEntry:
    """Return a refined entry, or ``entry`` itself when nothing applies."""
    if isinstance(entry, FlowCommandEntry):
        return entry  # idempotent — already derived
    flow = _derive_flow_command(entry)
    return flow if flow is not None else entry


def derive_entries(entries: Iterable[TranscriptEntry]) -> list[TranscriptEntry]:
    return [derive_entry(e) for e in entries]


# ── flow CLI ──────────────────────────────────────────────────────────────────


def _shell_command_text(entry: TranscriptEntry) -> str | None:
    """The shell command this entry ran, whatever worker shape it came in as."""
    if isinstance(entry, ShellCommandEntry):
        return entry.command or None
    if isinstance(entry, ToolUseEntry):
        if str(getattr(entry, "tool_name", "")).lower() not in SHELL_TOOL_NAMES:
            return None
        ti = getattr(entry, "tool_input", None)
        if not isinstance(ti, dict):
            return None
        cmd = ti.get("command")
        # Codex passes argv lists (``["bash", "-lc", "flow show …"]``).
        if isinstance(cmd, list):
            cmd = cmd[-1] if cmd else None
        return str(cmd) if cmd else None
    return None


def parse_flow_invocation(command: str) -> dict[str, Any] | None:
    """Parse ``flow …`` out of a shell command line.

    Returns ``{verb, subverb, target, args}`` or None when this isn't a flow
    CLI call. Deliberately narrow: only a bare ``flow`` token (optionally
    preceded by ``VAR=value`` assignments) followed by a known verb counts, so
    ``./flow``, ``flowctl`` and ``echo flow show`` are left alone.
    """
    # Cheap guard before the lexer: refolds re-derive the whole retained list on
    # every delta, and shlex.split is a real scan of what can be a multi-KB
    # heredoc. No ``flow`` substring, no possible flow invocation.
    if "flow" not in command:
        return None
    try:
        tokens = shlex.split(command)
    except ValueError:
        return None
    if not tokens:
        return None
    # Strip leading environment assignments: FLOW_INSTANCE=oss flow …
    i = 0
    while i < len(tokens) and "=" in tokens[i] and not tokens[i].startswith("-"):
        name = tokens[i].split("=", 1)[0]
        if not name or not name.replace("_", "").isalnum() or not name[0].isalpha():
            break
        i += 1
    if i >= len(tokens) or tokens[i] != "flow":
        return None
    rest = tokens[i + 1:]
    verb = next((t for t in rest if not t.startswith("-")), None)
    if verb is None or verb not in _FLOW_VERBS:
        return None
    after = rest[rest.index(verb) + 1:]
    positionals = [t for t in after if not t.startswith("-")]
    subverb = positionals[0] if positionals and positionals[0] in _TARGETED else None
    target = positionals[1] if subverb and len(positionals) > 1 else None
    return {"verb": verb, "subverb": subverb, "target": target, "args": after}


def _envelope(entry: TranscriptEntry) -> dict[str, Any]:
    """The base-class fields, as ``TranscriptEntry.__init__`` kwargs.

    Read off ``TranscriptEntry.to_dict`` **unbound** — it already serializes
    exactly the envelope, so a new envelope field is carried through here for
    free instead of needing a third hand-maintained copy of the field list.
    Calling it unbound matters: the subclass override would add its own fields
    (``command``, ``exit_code``, …), which the refined entry sets separately.
    """
    fields = TranscriptEntry.to_dict(entry)
    fields.pop("kind", None)  # class attribute, not a constructor kwarg
    return fields


def _derive_flow_command(entry: TranscriptEntry) -> FlowCommandEntry | None:
    command = _shell_command_text(entry)
    if not command:
        return None
    parsed = parse_flow_invocation(command)
    if parsed is None:
        return None
    shell_fields: dict[str, Any] = {
        "command": command,
        "cwd": getattr(entry, "cwd", None),
        "exit_code": getattr(entry, "exit_code", None),
        "stdout_preview": getattr(entry, "stdout_preview", None),
        "stderr_preview": getattr(entry, "stderr_preview", None),
        "duration_ms": getattr(entry, "duration_ms", None),
        "timeout": getattr(entry, "timeout", None),
        "tool_name": getattr(entry, "tool_name", "") or "",
        "tool_use_id": getattr(entry, "tool_use_id", "") or "",
    }
    return FlowCommandEntry(
        verb=parsed["verb"],
        subverb=parsed["subverb"],
        target=parsed["target"],
        flow_args=parsed["args"],
        **shell_fields,
        **_envelope(entry),
    )
