from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import TYPE_CHECKING
from uuid import uuid4

from flow_sdk.fs_records.agent_record import AgentRecord

if TYPE_CHECKING:
    from flow_sdk.builtin.agentic_process import AgenticProcess


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

    def run(
        self,
        instruction: str,
        workdir: str,
        env_vars: dict[str, str] | None = None,
    ) -> "AgenticProcess":
        """Run this agent in the given working directory.

        1. Copies agent .md into workdir/.claude/agents/
        2. Builds agents_json from AgentRecord.to_agents_json()
        3. Spawns via process_runner.run_process() with agents_json in env_vars
        4. Returns AgenticProcess wrapping the record
        """
        from flow_sdk.builtin.agentic_process import AgenticProcess
        from flow_sdk.builtin.process_runner import ProcessConfig, run_process

        session_id = str(uuid4())

        agents_dir = Path(workdir) / ".claude" / "agents"
        agents_dir.mkdir(parents=True, exist_ok=True)
        if self.record.record_dir and self.name:
            src_md = self.record.record_dir / f"{self.name}.md"
            if src_md.exists():
                shutil.copy2(src_md, agents_dir / f"{self.name}.md")

        agents_json = self.record.to_agents_json()

        config = ProcessConfig(
            skill_name=f"agent:{self.name}",
            instruction=instruction,
            workdir=workdir,
            model=self.model,
            permission_mode=self.record.data.get(
                "permission_mode", "bypassPermissions"
            ),
            env_vars={
                **(env_vars or {}),
                "CLAUDE_AGENTS_JSON": json.dumps(agents_json),
            },
        )
        record, _proc = run_process(
            config, workdir=workdir, session_id=session_id
        )

        return AgenticProcess.fromRecord(record)
