"""cli_workers — typed CLI command builders for worker processes.

Usage::

    from flow_sdk.builtin.cli_workers import factory, ClaudeCLICommand

    cmd = factory({"resume": True}, worker_type="claude")
    cmd.session_id = process.worker_session_id
    cmd.workdir = process.workdir
    cmd.add_env("FLOWPAD_EXECUTION_SCOPE", scope_json)
    shell_str = cmd.to_shell_string(instruction="fix the bug")
"""

from flow_sdk.builtin.cli_workers.base import WorkerCLICommand
from flow_sdk.builtin.cli_workers.claude_cli import ClaudeCLICommand

__all__ = ["WorkerCLICommand", "ClaudeCLICommand", "factory"]


def factory(cli_json: dict, worker_type: str) -> WorkerCLICommand:
    """Return the correct WorkerCLICommand subclass for the given worker_type.

    Args:
        cli_json: Serialised CLI config (from AgenticProcess.cli_config).
        worker_type: Worker type string from AgenticProcessor.worker_type.

    Returns:
        A WorkerCLICommand instance ready for add_env() / to_shell_string().

    Raises:
        ValueError: If worker_type is not recognised.
    """
    if worker_type == "claude":
        return ClaudeCLICommand.from_json(cli_json)
    raise ValueError(f"Unknown worker_type: {worker_type!r}")
