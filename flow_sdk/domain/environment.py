from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from typing_extensions import Self

from flow_sdk.fs_records.environment_record import EnvironmentRecord

if TYPE_CHECKING:
    from .shell import Shell


class Environment:
    """Hydrated execution environment with shell creation."""

    def __init__(self, record: EnvironmentRecord) -> None:
        self._record = record

    @property
    def record(self) -> EnvironmentRecord:
        return self._record

    @property
    def id(self) -> str:
        return self._record.id

    @property
    def name(self) -> str | None:
        return self._record.name

    @property
    def work_dir(self) -> str:
        return self.record.data.get("work_dir", "")

    @property
    def env_vars(self) -> dict[str, str]:
        return self.record.data.get("env_vars", {})

    @property
    def compute_node_id(self) -> str | None:
        return self.record.data.get("compute_node_id")

    def createShell(self) -> Shell:
        """Create a Shell for command execution in this environment.

        Without a compute_node_id, creates a sync-only Shell
        (run_sync works, run/stream raise RuntimeError).
        """
        from .shell import Shell
        return Shell(env=self)

    @classmethod
    def fromRecord(cls, record: EnvironmentRecord) -> Self:
        return cls(record)

    @classmethod
    def load(cls, work_dir: str) -> Self:
        """Create an Environment for a working directory.

        Creates an in-memory EnvironmentRecord (NOT saved to disk).
        Call record.save() explicitly if persistence is needed.
        """
        record = EnvironmentRecord(
            name=Path(work_dir).name,
            work_dir=work_dir,
        )
        return cls(record)
