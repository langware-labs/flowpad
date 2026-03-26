"""cli_workers — typed CLI command builders for worker processes.

Usage::

    from flow_sdk.builtin.cli_workers import factory, ClaudeCliOptions

    cmd = factory({"resume": True}, worker_type="claude")
    cmd.session_id = process.worker_session_id
    cmd.workdir = process.workdir
    cmd.add_env("FLOWPAD_EXECUTION_SCOPE", scope_json)
    shell_str = cmd.to_shell_string(instruction="fix the bug")
"""

from flow_sdk.builtin.cli_workers.base import WorkerCLIOptions
from flow_sdk.builtin.cli_workers.claude_cli import ClaudeCliOptions

__all__ = ["WorkerCLIOptions", "ClaudeCliOptions", "factory"]


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
        return ClaudeCliOptions.from_json(cli_json)
    raise ValueError(f"Unknown worker_type: {worker_type!r}")
