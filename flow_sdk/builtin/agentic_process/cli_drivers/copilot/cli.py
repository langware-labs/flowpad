"""GitHub Copilot CLI command builder."""

from __future__ import annotations

import logging
from typing import Any

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import WorkerCLIOptions

logger = logging.getLogger(__name__)


class CopilotCliOptions(WorkerCLIOptions):
    """Builds Copilot CLI argv for headless JSON streaming or visible PTY mode."""

    def __init__(
        self,
        session_id: str | None = None,
        resume: bool = False,
        model: str | None = None,
        permission_mode: str = "bypassPermissions",
        effort: str | None = None,
        skill_names: list[str] | None = None,
        workdir: str | None = None,
        env_vars: dict[str, str] | None = None,
        add_dirs: list[str] | None = None,
        json_stream: bool = True,
        no_ask_user: bool = True,
        no_auto_update: bool = True,
        no_custom_instructions: bool = True,
        allow_all: bool = True,
    ) -> None:
        super().__init__(workdir=workdir, env_vars=env_vars)
        self.session_id = session_id
        self.resume = resume
        self.model = model
        self.permission_mode = permission_mode
        self.effort = effort
        self.skill_names: list[str] = list(skill_names or [])
        self.add_dirs: list[str] = list(add_dirs or [])
        self.json_stream = json_stream
        self.no_ask_user = no_ask_user
        self.no_auto_update = no_auto_update
        self.no_custom_instructions = no_custom_instructions
        self.allow_all = allow_all

    def _build_worker_args(self) -> list[str]:
        import shlex

        argv, _env = self.to_spawn_args()
        args = [shlex.quote(a) for a in argv]
        for skill in self.skill_names:
            args.append(f"# skill={shlex.quote(skill)}")
        return args

    def to_spawn_args(self, instruction: str | None = None) -> tuple[list[str], dict[str, str]]:
        """Return argv/env for ``asyncio.create_subprocess_exec``.

        Copilot's headless path reads the prompt from stdin. ``instruction`` is
        accepted for API parity with other workers but intentionally ignored.
        """
        if not self.json_stream:
            argv: list[str] = ["copilot"]
            if self._allow_all_enabled():
                argv.append("--allow-all")
            if self.workdir:
                argv.extend(["-C", self.workdir])
            if self.model:
                argv.extend(["--model", self.model])
            if self.effort:
                argv.extend(["--effort", self.effort])
            for directory in self.add_dirs:
                argv.extend(["--add-dir", directory])
            if self.resume and self.session_id:
                argv.append(f"--resume={self.session_id}")
            elif self.session_id:
                argv.extend(["--session-id", self.session_id])
            return argv, dict(self.env_vars)

        argv = ["copilot", "--output-format=json", "--stream=on"]
        if self.no_ask_user:
            argv.append("--no-ask-user")
        if self.no_auto_update:
            argv.append("--no-auto-update")
        if self.no_custom_instructions:
            argv.append("--no-custom-instructions")
        if self._allow_all_enabled():
            argv.append("--allow-all")
        if self.workdir:
            argv.extend(["-C", self.workdir])
        if self.model:
            argv.extend(["--model", self.model])
        if self.effort:
            argv.extend(["--effort", self.effort])
        for directory in self.add_dirs:
            argv.extend(["--add-dir", directory])
        if self.resume and self.session_id:
            argv.append(f"--resume={self.session_id}")
        elif self.session_id:
            argv.extend(["--session-id", self.session_id])
        return argv, dict(self.env_vars)

    def to_json(self) -> dict[str, Any]:
        data = super().to_json()
        data.update({
            "worker_type": "copilot",
            "session_id": self.session_id,
            "resume": self.resume,
            "model": self.model,
            "permission_mode": self.permission_mode,
            "effort": self.effort,
            "skill_names": self.skill_names,
            "add_dirs": self.add_dirs,
            "json_stream": self.json_stream,
            "no_ask_user": self.no_ask_user,
            "no_auto_update": self.no_auto_update,
            "no_custom_instructions": self.no_custom_instructions,
            "allow_all": self.allow_all,
        })
        return data

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "CopilotCliOptions":
        return cls(
            session_id=data.get("session_id"),
            resume=bool(data.get("resume", False)),
            model=data.get("model"),
            permission_mode=data.get("permission_mode", "bypassPermissions"),
            effort=data.get("effort"),
            skill_names=list(data.get("skill_names") or []),
            workdir=data.get("workdir"),
            env_vars=data.get("env_vars") or {},
            add_dirs=list(data.get("add_dirs") or []),
            json_stream=bool(data.get("json_stream", True)),
            no_ask_user=bool(data.get("no_ask_user", True)),
            no_auto_update=bool(data.get("no_auto_update", True)),
            no_custom_instructions=bool(data.get("no_custom_instructions", True)),
            allow_all=bool(data.get("allow_all", True)),
        )

    def _allow_all_enabled(self) -> bool:
        return self.allow_all and self.permission_mode == "bypassPermissions"
