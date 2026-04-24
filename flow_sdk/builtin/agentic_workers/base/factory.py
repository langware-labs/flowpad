"""Factory for ``WorkerCLIOptions`` subclasses keyed by worker_type string.

The string keys (``"claude"``, ``"codex"``) are the wire form used by the
serialized ``AgenticProcess.cli_config`` field; they are intentionally short
and decoupled from ``WorkerType`` enum value names so renaming the enum
doesn't bump the on-disk schema.
"""

from __future__ import annotations

from flow_sdk.builtin.agentic_workers.base.cli_options import WorkerCLIOptions


def factory(cli_json: dict, worker_type: str) -> WorkerCLIOptions:
    """Return the correct WorkerCLIOptions subclass for the given worker_type.

    Args:
        cli_json: Serialised CLI config (from AgenticProcess.cli_config).
        worker_type: Worker type string from AgenticProcessor.worker_type.

    Returns:
        A WorkerCLIOptions instance ready for add_env() / to_shell_string().

    Raises:
        ValueError: If worker_type is not recognised.
    """
    if worker_type == "claude":
        # Local import: the claude_worker package depends on base, so importing
        # from it at module top-level would invert the dependency direction.
        from flow_sdk.builtin.agentic_workers.claude_worker.cli import ClaudeCliOptions

        return ClaudeCliOptions.from_json(cli_json)
    if worker_type == "codex":
        from flow_sdk.builtin.agentic_workers.codex_worker.cli import CodexCliOptions

        return CodexCliOptions.from_json(cli_json)
    raise ValueError(f"Unknown worker_type: {worker_type!r}")
