"""Vendor-neutral taxonomy for agentic "callables".

Agent flow control is mostly *context* control. Every callable an agent invokes
is classified along three axes so the call-stack report can reason about a run
the same way across Claude / Codex / Copilot / any future worker:

* **context_policy** — what happens to the context window:
  ``preserve`` (same context + added instructions), ``isolate`` (fresh child
  context, summary returns), ``transfer`` (hand the conversation to another
  agent), ``retrieve`` (inject snippets, store stays outside), ``compact``
  (reset window, carry a summary forward), ``checkpoint`` (persist/resume state).
* **control_policy** — how control flows: ``call`` (synchronous return),
  ``delegate`` (spawn a child), ``handoff`` (transfer control), ``parallelize``,
  ``pause``, ``approve``, ``resume``.
* **state_scope** — where the affected state lives: ``turn``, ``session``,
  ``project``, ``user``, ``organization``, ``global``.

This maps the full taxonomy (including handoff / workflow / memory) even though
some primitives never appear in today's worker transcripts — so the report is
stable as new ``TranscriptEntry`` kinds land. Pure + table-driven.
"""

from __future__ import annotations


class ContextPolicy:
    PRESERVE = "preserve"
    ISOLATE = "isolate"
    TRANSFER = "transfer"
    RETRIEVE = "retrieve"
    COMPACT = "compact"
    CHECKPOINT = "checkpoint"


class ControlPolicy:
    CALL = "call"
    DELEGATE = "delegate"
    HANDOFF = "handoff"
    PARALLELIZE = "parallelize"
    PAUSE = "pause"
    APPROVE = "approve"
    RESUME = "resume"


class StateScope:
    TURN = "turn"
    SESSION = "session"
    PROJECT = "project"
    USER = "user"
    ORGANIZATION = "organization"
    GLOBAL = "global"


# EntryKind.value → (context_policy, control_policy, state_scope).
# Tool-flavored kinds (shell/file/search/web/tool_use) are all syscalls:
# preserve context, synchronous call, turn-scoped.
_TOOL_POLICY = (ContextPolicy.PRESERVE, ControlPolicy.CALL, StateScope.TURN)

_POLICY_BY_KIND: dict[str, tuple[str, str, str]] = {
    "skill_call": (ContextPolicy.PRESERVE, ControlPolicy.CALL, StateScope.SESSION),
    "agent_spawn": (ContextPolicy.ISOLATE, ControlPolicy.DELEGATE, StateScope.SESSION),
    "compaction": (ContextPolicy.COMPACT, ControlPolicy.RESUME, StateScope.SESSION),
    "tool_use": _TOOL_POLICY,
    "shell_command": _TOOL_POLICY,
    "file_read": _TOOL_POLICY,
    "file_write": _TOOL_POLICY,
    "file_edit": _TOOL_POLICY,
    "search": _TOOL_POLICY,
    "web_fetch": (ContextPolicy.RETRIEVE, ControlPolicy.CALL, StateScope.TURN),
    "todo_update": (ContextPolicy.CHECKPOINT, ControlPolicy.CALL, StateScope.SESSION),
    # Frame-level synthetic kinds (the call tree emits these as container kinds).
    "session": (ContextPolicy.PRESERVE, ControlPolicy.CALL, StateScope.SESSION),
    "skill": (ContextPolicy.PRESERVE, ControlPolicy.CALL, StateScope.SESSION),
    "subagent": (ContextPolicy.ISOLATE, ControlPolicy.DELEGATE, StateScope.SESSION),
    "tool": _TOOL_POLICY,
    # Taxonomy-complete but not emitted by any worker today (no TranscriptEntry
    # yet). Listed so classification is stable when they land.
    "hook": (ContextPolicy.PRESERVE, ControlPolicy.APPROVE, StateScope.TURN),
    "approval": (ContextPolicy.PRESERVE, ControlPolicy.APPROVE, StateScope.TURN),
    "handoff": (ContextPolicy.TRANSFER, ControlPolicy.HANDOFF, StateScope.SESSION),
    "workflow": (ContextPolicy.CHECKPOINT, ControlPolicy.CALL, StateScope.PROJECT),
    "memory": (ContextPolicy.RETRIEVE, ControlPolicy.CALL, StateScope.PROJECT),
}

_DEFAULT_POLICY = _TOOL_POLICY


def classify_callable(kind: str, tool_name: str | None = None) -> dict:
    """Return ``{context_policy, control_policy, state_scope, mcp}`` for a callable.

    ``kind`` is an ``EntryKind.value`` or a call-tree frame kind. ``tool_name``
    distinguishes MCP tool calls (``mcp__<provider>__<tool>``) — still a
    preserve/call syscall, but flagged so the UI can badge it as an external
    driver. Unknown kinds default to the tool (syscall) policy.
    """
    context, control, scope = _POLICY_BY_KIND.get(kind, _DEFAULT_POLICY)
    return {
        "context_policy": context,
        "control_policy": control,
        "state_scope": scope,
        "mcp": bool(tool_name and tool_name.startswith("mcp__")),
    }
