from enum import Enum


class SubAgentKind(str, Enum):
    """Discriminates how an agent asset is used.

    - HARNESS: the default — a normal sub-agent that runs under the CLI harness
      (Claude Code / Codex / Copilot), discoverable as a ``.claude/agents/*.md``
      spec and invocable by the worker.
    - VIBE: a vibe persona layered on top of the standard vibe agent. On vibe
      process start, all in-scope ``kind==vibe`` agents are embedded into the
      instructions AFTER the standard vibe agent, in created-date order.
    """

    HARNESS = "harness"
    VIBE = "vibe"
