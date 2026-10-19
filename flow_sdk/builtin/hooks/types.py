"""Shared hook vocabulary — scopes, events, capabilities and typed responses.

This module is the bottom of the hook dependency stack. It deliberately imports
nothing from ``flow_sdk.builtin.agent_hook`` (which pulls in ``Trigger``) so that
``HooksManager`` and the vendor drivers can share one vocabulary without taking a
dependency on the trigger layer. Triggers may depend on hooks; hooks may not
depend on triggers.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

from flow_sdk._compat import StrEnum


class HookScope(StrEnum):
    """Where a hook is configured — and therefore what it fires for.

    The first three are *global*: a persisted file the harness discovers on its
    own, so the hook fires for every run of that harness, including runs Flowpad
    never launched. ``PROCESS`` is *local*: argv the launcher supplies, so it
    exists only for a process Flowpad spawned and dies with it.
    """

    USER = "user"  # ~/.claude/settings.json · ~/.codex/config.toml
    PROJECT = "project"  # <repo>/.claude/settings.json — committed to git
    LOCAL_PROJECT = "local"  # <repo>/.claude/settings.local.json — gitignored
    PROCESS = "process"  # per-AgenticProcess, handed over at launch

    #: Pre-existing spelling of ``LOCAL_PROJECT``. Same wire value, so rows and
    #: settings files written before the rename keep resolving.
    LOCAL = "local"


#: The global scopes, in precedence order (broadest first).
GLOBAL_SCOPES: tuple[HookScope, ...] = (
    HookScope.USER,
    HookScope.PROJECT,
    HookScope.LOCAL_PROJECT,
)


class AgentProvider(StrEnum):
    """Agent provider types."""

    CLAUDE_CODE = "claude_code"
    # Future: CURSOR = "cursor", etc.
class HookEventType(StrEnum):
    """Types of hook events from Claude Code.

    Based on Claude Code hooks documentation:
    https://code.claude.com/docs/en/hooks
    """

    # Session lifecycle events
    SESSION_START = "SessionStart"
    SESSION_END = "SessionEnd"

    # User interaction events
    USER_PROMPT_SUBMIT = "UserPromptSubmit"
    NOTIFICATION = "Notification"

    # Tool events
    PRE_TOOL_USE = "PreToolUse"
    POST_TOOL_USE = "PostToolUse"
    POST_TOOL_USE_FAILURE = "PostToolUseFailure"
    PERMISSION_REQUEST = "PermissionRequest"

    # Agent stop/start events
    STOP = "Stop"
    STOP_FAILURE = "StopFailure"
    SUBAGENT_START = "SubagentStart"
    SUBAGENT_STOP = "SubagentStop"

    # Agent teams events
    TEAMMATE_IDLE = "TeammateIdle"
    TASK_CREATED = "TaskCreated"
    TASK_COMPLETED = "TaskCompleted"

    # Configuration events
    CONFIG_CHANGE = "ConfigChange"
    INSTRUCTIONS_LOADED = "InstructionsLoaded"

    # Worktree events
    WORKTREE_CREATE = "WorktreeCreate"
    WORKTREE_REMOVE = "WorktreeRemove"

    # Compaction events
    PRE_COMPACT = "PreCompact"
    POST_COMPACT = "PostCompact"

    # MCP elicitation events
    ELICITATION = "Elicitation"
    ELICITATION_RESULT = "ElicitationResult"

    # File system events
    CWD_CHANGED = "CwdChanged"
    FILE_CHANGED = "FileChanged"


# Hook events that don't use matchers (always fire on every occurrence)
HOOK_EVENTS_NO_MATCHER = [
    HookEventType.USER_PROMPT_SUBMIT,
    HookEventType.STOP,
    HookEventType.TEAMMATE_IDLE,
    HookEventType.TASK_COMPLETED,
    HookEventType.WORKTREE_CREATE,
    HookEventType.WORKTREE_REMOVE,
    HookEventType.CWD_CHANGED,
    HookEventType.FILE_CHANGED,
]

# Hook events that use matchers
HOOK_EVENTS_WITH_MATCHER = [
    HookEventType.PRE_TOOL_USE,
    HookEventType.POST_TOOL_USE,
    HookEventType.POST_TOOL_USE_FAILURE,
    HookEventType.PERMISSION_REQUEST,
    HookEventType.SESSION_START,
    HookEventType.SESSION_END,
    HookEventType.NOTIFICATION,
    HookEventType.SUBAGENT_START,
    HookEventType.SUBAGENT_STOP,
    HookEventType.STOP_FAILURE,
    HookEventType.PRE_COMPACT,
    HookEventType.POST_COMPACT,
    HookEventType.CONFIG_CHANGE,
    HookEventType.INSTRUCTIONS_LOADED,
    HookEventType.ELICITATION,
    HookEventType.ELICITATION_RESULT,
]

# All available hook events
ALL_HOOK_EVENTS = HOOK_EVENTS_NO_MATCHER + HOOK_EVENTS_WITH_MATCHER

# Default hooks to listen to — excludes worktree create event (which would replace the default behavior)
DEFAULT_LISTENED_HOOKS = [e for e in ALL_HOOK_EVENTS if e != HookEventType.WORKTREE_CREATE]


# ---------------------------------------------------------------------------
# Capability declaration
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class HookCapability:
    """What one harness can do at one scope.

    A driver declares one of these per scope it supports. A scope the driver does
    not declare is unsupported, and ``HooksManager.configure`` raises
    ``NotImplementedError`` for it — at configure time, never silently at
    delivery, so a hook that can never fire is impossible to install.
    """

    #: Events the harness can be configured for at this scope.
    events: frozenset["HookEventType"] = frozenset()
    #: Subset of ``events`` whose handler output the harness reads back.
    response_events: frozenset["HookEventType"] = frozenset()
    #: Human-readable note, surfaced in the NotImplementedError of sibling cells.
    note: str = ""

    def supports(self, event: "HookEventType") -> bool:
        return event in self.events

    def supports_response(self, event: "HookEventType") -> bool:
        return event in self.response_events


#: A driver's full declaration: scope -> capability. Absent scope == unsupported.
HookCapabilities = dict[HookScope, HookCapability]


@dataclass(frozen=True)
class HookInfo:
    """One configured hook, as reported by ``HooksManager.list``."""

    event: "HookEventType"
    scope: HookScope
    provider: str
    #: Identity carried in the projected command string.
    hook_id: Optional[str] = None
    #: True when the entry exists in the harness file but Flowpad did not write
    #: it (a hand-written or third-party hook). Never removable through us.
    foreign: bool = False
    matcher: Optional[dict[str, Any]] = None


# ---------------------------------------------------------------------------
# Typed responses
# ---------------------------------------------------------------------------


class PermissionBehavior(StrEnum):
    ALLOW = "allow"
    DENY = "deny"
    ASK = "ask"


@dataclass(frozen=True)
class PermissionResponse:
    """Answer to PreToolUse / PermissionRequest."""

    behavior: PermissionBehavior
    reason: str = ""
    updated_input: Optional[dict[str, Any]] = None


@dataclass(frozen=True)
class BlockResponse:
    """Answer to PostToolUse / Stop / SubagentStop — stop or let it through."""

    block: bool = False
    reason: str = ""


@dataclass(frozen=True)
class ContextResponse:
    """Answer to UserPromptSubmit / SessionStart — inject context, or block."""

    additional_context: str = ""
    block: bool = False
    reason: str = ""


#: Anything a callback may return. ``None`` means "no opinion" and is the only
#: answer produced when no callback is registered.
AgentHookResponse = PermissionResponse | BlockResponse | ContextResponse


@dataclass(frozen=True)
class HookOutcome:
    """What the harness should OBSERVE from a hook handler.

    The pair matters:

    * ``AgentHookResponse`` is semantic and vendor-neutral — what a callback
      decided.
    * ``HookOutcome`` is process-observable and vendor-shaped — how a particular
      harness learns of that decision.

    A hook's answer is not "stdout JSON": measured across the shipped CLIs, each
    harness reads a different combination of the three channels for the same
    semantic. Claude treats exit 2 as a blocking error and feeds the output back
    to the model; codex treats exit 2 as blocking too but reads **stderr** as the
    payload; copilot treats exit 2 as a mere warning unless configured otherwise.
    Only an envelope carrying all three can express that.

    The default is deliberately inert — exit 0, nothing written. Exit 2 is how a
    turn gets BLOCKED on claude and codex, so a non-zero code must always be an
    explicit decision by a vendor renderer, never something that falls out of a
    missing branch.
    """

    exit_code: int = 0
    stdout: Optional[dict[str, Any]] = None
    stderr: str = ""

    @property
    def is_silent(self) -> bool:
        """True when the harness would observe nothing at all."""
        return self.exit_code == 0 and not self.stdout and not self.stderr

    def to_wire(self) -> dict[str, Any]:
        """Serialize for the hook-report response body."""
        return {"exit_code": self.exit_code, "stdout": self.stdout, "stderr": self.stderr}

    @classmethod
    def from_wire(cls, payload: Any) -> "HookOutcome":
        """Parse a wire envelope, falling back to inert on anything malformed.

        The caller is a CLI holding a worker's turn open, so a garbled payload
        must never become a non-zero exit — that would block the turn.
        """
        if not isinstance(payload, dict):
            return cls()
        code = payload.get("exit_code", 0)
        stdout = payload.get("stdout")
        stderr = payload.get("stderr", "")
        return cls(
            exit_code=code if isinstance(code, int) and not isinstance(code, bool) else 0,
            stdout=stdout if isinstance(stdout, dict) else None,
            stderr=stderr if isinstance(stderr, str) else "",
        )


#: Reserved key carrying a :class:`HookOutcome` in the hook-report response body.
HOOK_OUTCOME_KEY = "hook_outcome"
