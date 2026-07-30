"""Claude Code CLI driver.

Re-exports the public surface so callers can
``from flow_sdk.builtin.agentic_process.cli_drivers.claude import
ClaudeDriver, ClaudeAgentOptions, ...`` without knowing the per-file layout.

``ClaudeCodeAgenticWorker`` is wrapped in ``try/except ImportError`` because
its ``claude_agent_sdk`` dependency is optional.
"""

from flow_sdk.builtin.agentic_process.cli_drivers.claude.cli import ClaudeAgentOptions
from flow_sdk.builtin.agentic_process.cli_drivers.claude.cli_worker import ClaudeCLIWorker
from flow_sdk.builtin.agentic_process.cli_drivers.claude.driver import ClaudeDriver
from flow_sdk.builtin.agentic_process.cli_drivers.claude.event_to_flowdata import (
    convert_event,
    convert_line,
    final_end_frame,
)
from flow_sdk.builtin.agentic_process.cli_drivers.claude.session_history import (
    get_session_jsonl_path,
    load_session_history,
)
from flow_sdk.builtin.agentic_process.cli_drivers.claude.stream_worker import (
    CANCEL_GRACE_SECONDS,
    ClaudeCLIStreamWorker,
)

try:
    from flow_sdk.builtin.agentic_process.cli_drivers.claude.code_agentic_worker import (
        ClaudeCodeAgenticWorker,
    )
except ImportError:  # claude_agent_sdk is optional
    ClaudeCodeAgenticWorker = None  # type: ignore[assignment]

__all__ = [
    "CANCEL_GRACE_SECONDS",
    "ClaudeCLIStreamWorker",
    "ClaudeCLIWorker",
    "ClaudeAgentOptions",
    "ClaudeCodeAgenticWorker",
    "ClaudeDriver",
    "convert_event",
    "convert_line",
    "final_end_frame",
    "get_session_jsonl_path",
    "load_session_history",
]
