"""Deep Agents command builder — the argv of OUR runner (``python -m …deepagents.runner``).

One shape only. There is no interactive TUI to host in a terminal tab (``Vendor.interactive`` is
False), so unlike the other vendors there is no ``json_stream`` switch: every launch is the
headless JSONL stream.

The binary is this backend's own interpreter, not something found on PATH — the harness is a
Python package installed beside FlowPad.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import AgentOptions
from flow_sdk.builtin.agentic_process.cli_drivers.deepagents.runner import (
    MODULE as RUNNER_MODULE,
)
from flow_sdk.builtin.agentic_process.model_tiers import DEEPAGENTS_MODEL_TIERS

#: Where a mounted dir keeps its skills — the layout deepagents' skill loader reads natively.
SKILLS_SUBDIR = Path(".claude") / "skills"
#: A workdir's own standing instructions, first match wins (the agents standard, then claude's).
MEMORY_FILES = ("AGENTS.md", "CLAUDE.md")


class DeepAgentsAgentOptions(AgentOptions):
    """Builds the runner argv for one headless turn."""

    MODEL_TIERS = DEEPAGENTS_MODEL_TIERS

    EXECUTABLE = Path(sys.executable).name
    # The runner reads the prompt from stdin to EOF, so a multi-line prompt is safe.
    PROMPT_CHANNEL = "stdin"
    SYSTEM_PROMPT_FLAG = "--system-prompt"
    SYSTEM_PROMPT_FILE_FLAG = "--system-prompt-file"

    def __init__(
        self,
        session_id: str | None = None,
        model: str | None = None,
        permission_mode: str = "bypassPermissions",
        workdir: str | None = None,
        env_vars: dict[str, str] | None = None,
        add_dirs: list[str] | None = None,
    ) -> None:
        super().__init__(workdir=workdir, env_vars=env_vars)
        self.session_id = session_id
        self.model = model
        self.permission_mode = permission_mode
        self.add_dirs: list[str] = list(add_dirs or [])
        # Claude-shaped ``--agents`` JSON for this launch. Launch-time only — never serialized.
        self.agents_json: dict = {}

    def _resolve_binary(self) -> list[str]:
        return [sys.executable, "-m", RUNNER_MODULE]

    def _skills_dirs(self) -> list[str]:
        roots = [Path(d) / SKILLS_SUBDIR for d in self.add_dirs]
        if self.workdir:
            roots.append(Path(self.workdir) / SKILLS_SUBDIR)
        seen: list[str] = []
        for root in roots:
            if root.is_dir() and str(root) not in seen:
                seen.append(str(root))
        return seen

    def _memory_file(self) -> str | None:
        if not self.workdir:
            return None
        for name in MEMORY_FILES:
            candidate = Path(self.workdir) / name
            if candidate.is_file():
                return str(candidate)
        return None

    def _emit_flags(self) -> list[str]:
        from flow_sdk.builtin.agentic_process.cli_drivers.deepagents.session_history import (  # noqa: PLC0415
            checkpoint_db_for_session,
        )

        if not self.session_id:
            raise ValueError("the deepagents runner needs a session id (the driver preassigns one)")
        flags = [
            "--session-id",
            self.session_id,
            "--checkpoint-db",
            str(checkpoint_db_for_session(self.session_id)),
            "--permission-mode",
            self.permission_mode,
        ]
        if self.workdir:
            flags.extend(["--workdir", self.workdir])
        if self.resolved_model:
            flags.extend(["--model", self.resolved_model])
        for skills_dir in self._skills_dirs():
            flags.extend(["--skills-dir", skills_dir])
        memory = self._memory_file()
        if memory:
            flags.extend(["--memory-file", memory])
        if self.mcp_config_fragment:
            flags.extend(["--mcp-config", json.dumps(self.mcp_config_fragment, separators=(",", ":"))])
        if self.agents_json:
            flags.extend(["--agents-json", json.dumps(self.agents_json, separators=(",", ":"))])
        return flags

    # ── Serialisation ───────────────────────────────────────────────────────
    WORKER_TYPE = "deepagents"
    SERIALIZED_FIELDS = ("session_id", "model", "permission_mode", "add_dirs")
    _COERCE = {"add_dirs": lambda v: list(v or [])}


#: The options class ``factory`` builds for this vendor.
AGENT_OPTIONS = DeepAgentsAgentOptions
