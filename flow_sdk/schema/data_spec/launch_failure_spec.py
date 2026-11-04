"""Why a worker launch failed: ``data.launch_failure`` on a refusal and ``AgenticProcess.launch_failure``."""

from typing import ClassVar

from flow_sdk.schema.data_spec.spec import DataSpec


class LaunchFailureSpec(DataSpec):
    spec_kind: ClassVar[str] = "agent.launch_failure"
    code: str
    health: str
    worker_type: str = ""
    phase: str = "spawn"  # preflight | spawn | blocked | first_turn
    detail: str = ""
    evidence: str = ""  # stderr / vendor error / screen text, last 2 KB
    facts: dict[str, str] = {}  # folder / provider / key_hint / source_name
    fix: str = "retry"
