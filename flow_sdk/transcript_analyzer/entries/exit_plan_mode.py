"""``ExitPlanModeEntry`` — a ``ToolUseEntry`` for the ``ExitPlanMode`` tool.

Only the Claude parser produces this. Defined alongside the generic entries
because the tool itself is worker-agnostic in name; ``planFilePath`` is what
``flow_sdk/app/actions/listen.py`` needs to resolve the persisted plan file
under ``~/.claude/plans/``.
"""

from __future__ import annotations

from .tool_use import ToolUseEntry


class ExitPlanModeEntry(ToolUseEntry):
    """``ExitPlanMode`` tool_use — exposes the plan text and persisted file path."""

    @property
    def plan_text(self) -> str:
        return str(self.tool_input.get("plan", "") or "")

    @property
    def plan_file_path(self) -> str:
        """Absolute path to the persisted plan file, or '' if absent.

        Newer Claude Code versions emit ``planFilePath`` directly on the
        ``ExitPlanMode`` tool_input. Older versions don't — callers must
        treat absence as "not available" rather than an error.
        """
        return str(self.tool_input.get("planFilePath", "") or "")
