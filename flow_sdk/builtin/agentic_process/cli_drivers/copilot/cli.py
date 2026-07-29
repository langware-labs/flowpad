"""GitHub Copilot CLI command builder."""

from __future__ import annotations

import logging
import os
from typing import Any

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import AgentOptions
from flow_sdk.builtin.agentic_process.model_tiers import COPILOT_MODEL_TIERS

logger = logging.getLogger(__name__)


class CopilotAgentOptions(AgentOptions):
    """Builds Copilot CLI argv for headless JSON streaming or visible PTY mode."""

    # sm/md/lg → gpt-5.4-mini/gpt-5.4/gpt-5.5, applied when emitting command.
    MODEL_TIERS = COPILOT_MODEL_TIERS

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
        custom_instruction_dirs: list[str] | None = None,
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
        self.custom_instruction_dirs: list[str] = list(custom_instruction_dirs or [])

    EXECUTABLE = "copilot"
    PROMPT_CHANNEL = "stdin"  # copilot reads the prompt from stdin
    SYSTEM_PROMPT_FLAG = None  # no flag — a system-prompt addition prepends into stdin

    def _common_tail(self) -> list[str]:
        """Flags shared by both transports: cwd, model, effort, add-dirs, session."""
        tail: list[str] = []
        if self.workdir:
            tail.extend(["-C", self.workdir])
        if self.resolved_model:
            tail.extend(["--model", self.resolved_model])
        if self.effort:
            tail.extend(["--effort", self.effort])
        for directory in self.add_dirs:
            tail.extend(["--add-dir", directory])
        if self.resume and self.session_id:
            tail.append(f"--resume={self.session_id}")
        elif self.session_id:
            tail.extend(["--session-id", self.session_id])
        return tail

    def _emit_flags(self) -> list[str]:
        """argv after ``copilot``. Two shapes keyed on ``json_stream`` (headless
        JSON stream vs interactive PTY); both end with the shared
        :meth:`_common_tail`."""
        allow_all = ["--allow-all"] if self._allow_all_enabled() else []
        if not self.json_stream:
            return allow_all + self._common_tail()

        head = ["--output-format=json", "--stream=on"]
        if self.no_ask_user:
            head.append("--no-ask-user")
        if self.no_auto_update:
            head.append("--no-auto-update")
        if self.no_custom_instructions and not self.custom_instruction_dirs:
            head.append("--no-custom-instructions")
        return head + allow_all + self._common_tail()

    def _sync_custom_instruction_env(self) -> None:
        # Copilot CLI 1.0.70 consults this child-process env at its folder-trust
        # gate. ``--allow-all`` alone does not bypass that interactive dialog.
        # Set it only for interactive full-access launches; it neither reads nor
        # mutates the user's persistent ``~/.copilot/config.json``.
        if not self.json_stream and self._allow_all_enabled():
            self.env_vars["COPILOT_ALLOW_ALL"] = "true"
        if not self.custom_instruction_dirs:
            return
        existing = self.env_vars.get("COPILOT_CUSTOM_INSTRUCTIONS_DIRS") or os.environ.get("COPILOT_CUSTOM_INSTRUCTIONS_DIRS", "")
        parts = [p for p in existing.split(",") if p]
        for directory in self.custom_instruction_dirs:
            if directory not in parts:
                parts.append(directory)
        self.env_vars["COPILOT_CUSTOM_INSTRUCTIONS_DIRS"] = ",".join(parts)

    def to_spawn(
        self, instruction: str | None = None, system_prompt_append: str | None = None
    ) -> tuple[list[str], dict[str, str], str | None]:
        self._sync_custom_instruction_env()
        return super().to_spawn(instruction=instruction, system_prompt_append=system_prompt_append)

    def to_spawn_args(self, instruction: str | None = None) -> tuple[list[str], dict[str, str]]:
        self._sync_custom_instruction_env()
        return super().to_spawn_args(instruction=instruction)

    def to_shell_string(self, instruction: str | None = None) -> str:
        self._sync_custom_instruction_env()
        return super().to_shell_string(instruction=instruction)

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
    def from_json(cls, data: dict[str, Any]) -> "CopilotAgentOptions":
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
