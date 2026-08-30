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

    # Native sm/md/lg delegate to Copilot auto by omitting --model at emission.
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
        plugin_dirs: list[str] | None = None,
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
        self.plugin_dirs: list[str] = list(plugin_dirs or [])

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
        for directory in self.plugin_dirs:
            tail.extend(["--plugin-dir", directory])
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
        existing = self.env_vars.get("COPILOT_CUSTOM_INSTRUCTIONS_DIRS") or os.environ.get(
            "COPILOT_CUSTOM_INSTRUCTIONS_DIRS", ""
        )
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

    # ── Serialisation ───────────────────────────────────────────────────────
    # The base AgentOptions.to_json / from_json do the work; this is the whole
    # declaration of this vendor's wire shape. Key names and value types are
    # frozen — see tests/unit/test_agent_options_serialization_golden.py.

    WORKER_TYPE = "copilot"
    SERIALIZED_FIELDS = (
        "session_id",
        "resume",
        "model",
        "permission_mode",
        "effort",
        "skill_names",
        "add_dirs",
        "json_stream",
        "no_ask_user",
        "no_auto_update",
        "no_custom_instructions",
        "allow_all",
    )
    _COERCE = {
        "resume": bool,
        "json_stream": bool,
        "no_ask_user": bool,
        "no_auto_update": bool,
        "no_custom_instructions": bool,
        "allow_all": bool,
        "skill_names": lambda v: list(v or []),
        "add_dirs": lambda v: list(v or []),
    }

    def _allow_all_enabled(self) -> bool:
        return self.allow_all and self.permission_mode == "bypassPermissions"


#: The options class ``factory`` builds for this vendor.
AGENT_OPTIONS = CopilotAgentOptions
