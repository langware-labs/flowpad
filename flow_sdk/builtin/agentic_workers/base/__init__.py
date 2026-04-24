"""Cross-vendor primitives shared by all agentic worker implementations.

Concrete vendors (Claude, Codex, …) live in sibling packages
(``..claude_worker``, ``..codex_worker``) and import their CLI option / worker
contracts from here.
"""

from flow_sdk.builtin.agentic_workers.base.cli_options import (
    WorkerCLIOptions,
    WorkerExecutionInfo,
)
from flow_sdk.builtin.agentic_workers.base.context import AgenticContext
from flow_sdk.builtin.agentic_workers.base.factory import factory
from flow_sdk.builtin.agentic_workers.base.worker import AgenticWorker

__all__ = [
    "AgenticContext",
    "AgenticWorker",
    "WorkerCLIOptions",
    "WorkerExecutionInfo",
    "factory",
]
