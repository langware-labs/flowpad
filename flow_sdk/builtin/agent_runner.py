from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_records.agent_record import AgentRecord


class AgentRunner:
    """Hydrated agent with execution capabilities."""

    def __init__(self, record: AgentRecord) -> None:
        self._record = record

    @property
    def record(self) -> AgentRecord:
        return self._record

    @property
    def id(self) -> str:
        return self._record.id

    @property
    def name(self) -> str | None:
        return self._record.name

    @classmethod
    def fromRecord(cls, record: AgentRecord) -> AgentRunner:
        return cls(record)

    @classmethod
    def load(cls, name: str, project_dir: str | Path | None = None) -> AgentRunner:
        """Load agent with priority: project > user > system.

        Raises FileNotFoundError if agent not found.
        """
        record = AgentRecord.load_agent(name, project_dir)
        if record is None:
            raise FileNotFoundError(f"Agent '{name}' not found")
        return cls.fromRecord(record)

    @classmethod
    def system_agent(cls, name: str) -> AgentRunner:
        """Load a bundled SDK system agent by name.

        Searches flow_sdk/system_assets/agents/<name>/ only.
        Raises FileNotFoundError if not found.
        """
        record = AgentRecord.load_system_agent(name)
        if record is None:
            raise FileNotFoundError(f"System agent '{name}' not found in SDK system_assets")
        return cls.fromRecord(record)

    @property
    def prompt(self) -> str:
        return self.record.prompt

    @property
    def model(self) -> str | None:
        return self.record.data.get("model")

