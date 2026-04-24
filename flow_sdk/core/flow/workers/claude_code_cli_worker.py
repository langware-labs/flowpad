"""
Claude Code CLI Worker

Extends BasePTYWorker with Claude-specific CLI options (print mode).
"""

from flow_sdk.builtin.agentic_workers.claude_worker import ClaudeCliOptions

from .base_pty_worker import BasePTYWorker


class ClaudeCodeCLIWorker(BasePTYWorker):
    """Worker that executes Claude CLI via PTY session in print mode."""

    def _build_cli_options(self, session_id: str, workdir: str) -> ClaudeCliOptions:
        return ClaudeCliOptions(
            session_id=session_id,
            workdir=workdir,
            print_mode=True,
        )
