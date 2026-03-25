from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import TYPE_CHECKING
from uuid import uuid4

from flow_sdk.fs_records.agent_record import AgentRecord

if TYPE_CHECKING:
    from .environment import Environment
    from .agentic_process import AgenticProcess


class Agent:
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
    def fromRecord(cls, record: AgentRecord) -> Agent:
        return cls(record)

    @classmethod
    def load(cls, name: str, project_dir: str | Path | None = None) -> Agent:
        """Load agent with priority: project > user > system.

        Raises FileNotFoundError if agent not found.
        """
        record = AgentRecord.load_agent(name, project_dir)
        if record is None:
            raise FileNotFoundError(f"Agent '{name}' not found")
        return cls.fromRecord(record)

    @classmethod
    def system_agent(cls, name: str) -> Agent:
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

    def run(self, instruction: str, env: Environment) -> AgenticProcess:
        """Run this agent in the given environment.

        1. Copies agent .md into env's .claude/agents/ directory
        2. Builds agents_json from AgentRecord.to_agents_json()
        3. Spawns via process_runner.run_process() with agents_json in env_vars
        4. Returns AgenticProcess wrapping the record

        For full ClaudeProjectEnvManager features (session management,
        rules engine, plugins), use ClaudeProjectEnvManager directly.
        """
        from .agentic_process import AgenticProcess as AgenticProcessDO
        from flow_sdk.builtin.process_runner import ProcessConfig, run_process

        session_id = str(uuid4())

        # 1. Copy agent .md into env's .claude/agents/
        agents_dir = Path(env.work_dir) / ".claude" / "agents"
        agents_dir.mkdir(parents=True, exist_ok=True)
        if self.record.record_dir and self.name:
            src_md = self.record.record_dir / f"{self.name}.md"
            if src_md.exists():
                shutil.copy2(src_md, agents_dir / f"{self.name}.md")

        # 2. Build agents_json
        agents_json = self.record.to_agents_json()

        # 3. Spawn via run_process()
        config = ProcessConfig(
            skill_name=f"agent:{self.name}",
            instruction=instruction,
            workdir=env.work_dir,
            model=self.model,
            permission_mode=self.record.data.get(
                "permission_mode", "bypassPermissions"
            ),
            env_vars={
                **env.env_vars,
                "CLAUDE_AGENTS_JSON": json.dumps(agents_json),
            },
        )
        record, _proc = run_process(
            config, workdir=env.work_dir, session_id=session_id
        )

        return AgenticProcessDO.fromRecord(record)
