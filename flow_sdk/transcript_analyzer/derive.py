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
from pathlib import PurePosixPath
from typing import Any, Iterable

from .entries import ShellCommandEntry, ToolUseEntry
from .entry import TranscriptEntry

# Tool names that carry a raw shell command in ``tool_input['command']``.
# Public: the Copilot parser shares this list so "what counts as a shell
# tool" is defined once.
# Claude's ``Bash`` is already a ShellCommandEntry by the time we see it;
# Codex (``shell``) and Copilot (``bash``) arrive as generic tool uses.
SHELL_TOOL_NAMES = frozenset({"bash", "shell", "run_command", "exec_command", "terminal"})

# Registered top-level `flow` commands (flow_sdk/cli/flow_cli.py). An unknown
# verb does NOT derive — better a generic shell chip than a bogus flow chip.
_FLOW_VERBS = frozenset(
    {
        "app",
        "artifact",
        "auth",
        "connect",
        "connections",
        "config",
        "context",
        "conversation",
        "diagnose",
        "hooks",
        "instance",
        "log",
        "migrate",
        "navigate",
        "ping",
        "process",
        "progress",
        "prompt",
        "record",
        "schema",
        "setup",
        "show",
        "start",
        "status",
        "stop",
        "tag",
        "terminal",
        "trace",
        "upgrade",
        "uninstall",
        "wizard",
    }
)

# Sub-commands whose first positional argument is the thing being addressed —
# the UI turns that into a clickable target.
_TARGETED = frozenset({"entity", "file", "asset", "record", "url", "webapp"})


def derive_entries(entries: Iterable[TranscriptEntry]) -> list[TranscriptEntry]:
    """Physical entries with every derivable meaning appended beside them.

    Delegates to the derivation layer (``derivation/``). This module keeps only
    the shell/flow *lexing* the handlers share — what counts as a shell tool,
    how to unwrap a login shell, how to read a ``flow`` invocation out of a
    command line. The policy of which entries exist lives with the handlers.
    """
    from .derivation import derive_entries as _derive  # noqa: PLC0415 — cycle

    return _derive(entries)


def derive_entry(entry: TranscriptEntry) -> TranscriptEntry:
    """The single-entry refinement, kept for the live converters.

    Returns the deepest refinement of ``entry`` — the artifact entry for a
    ``flow artifact`` call, the flow-command entry for any other ``flow`` call,
    otherwise ``entry`` unchanged.

    The live path converts one worker event into one frame, so it wants the
    entry a chip should render, not the whole chain. The recorded transcript
    still carries both, because ``derive_entries`` runs additively over the
    retained list on every refold.
    """
    from .derivation.registry import _derive_from  # noqa: PLC0415 — cycle

    generated = _derive_from(entry)
    return generated[-1] if generated else entry


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


#: Shells a harness may hand the real command to as a single `-c` string.
_SHELL_WRAPPERS = frozenset({"sh", "bash", "zsh", "dash", "ksh", "fish"})


def _unwrap_shell_c(tokens: list[str]) -> list[str] | None:
    """``/bin/zsh -lc 'flow artifact file x'`` → the INNER command's tokens.

    Codex hands the OS a login shell and passes the real command as one quoted
    argument, so the leading token is the shell binary and never ``flow``.
    Without unwrapping, every ``flow`` call on codex silently degrades to a
    generic shell chip — the vendor's argv-list form (``["bash","-lc",cmd]``)
    hid this, because that branch already reads the last element.

    One level only: a shell invoking a shell is not a Flowpad CLI call worth
    chasing, and bounded depth keeps this safe on a hot per-entry path.
    """
    if len(tokens) < 3:
        return None
    if PurePosixPath(tokens[0]).name not in _SHELL_WRAPPERS:
        return None
    flag = tokens[1]
    if not flag.startswith("-") or "c" not in flag:
        return None
    try:
        inner = shlex.split(tokens[2])
    except ValueError:
        return None
    return inner or None


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
    # `/bin/zsh -lc 'flow …'` — the real command hidden inside a login shell.
    tokens = _unwrap_shell_c(tokens) or tokens
    # Strip leading environment assignments: FLOW_INSTANCE=oss flow …
    i = 0
    while i < len(tokens) and "=" in tokens[i] and not tokens[i].startswith("-"):
        name = tokens[i].split("=", 1)[0]
        if not name or not name.replace("_", "").isalnum() or not name[0].isalpha():
            break
        i += 1
    if i >= len(tokens) or tokens[i] != "flow":
        return None
    rest = tokens[i + 1 :]
    verb = next((t for t in rest if not t.startswith("-")), None)
    if verb is None or verb not in _FLOW_VERBS:
        return None
    after = rest[rest.index(verb) + 1 :]
    positionals = [t for t in after if not t.startswith("-")]
    subverb = positionals[0] if positionals and positionals[0] in _TARGETED else None
    target = positionals[1] if subverb and len(positionals) > 1 else None
    return {"verb": verb, "subverb": subverb, "target": target, "args": after}
