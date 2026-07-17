"""CodexCliOptions — builds OpenAI Codex CLI shell command strings.

Mirrors the shape of ``ClaudeCliOptions`` for the ``codex exec`` non-interactive
path. The codex worker runs ``codex exec --json`` per turn; the JSON event
stream is what gets converted to FlowData.

Notes on flag mapping:
- ``--cd <workdir>``                       → workdir
- ``--add-dir <dir>`` (repeatable)         → add_dirs
- ``--skip-git-repo-check``                → always set; tests run in tmp dirs
- ``--dangerously-bypass-approvals-and-sandbox`` → permission_mode == "bypassPermissions"
- ``--ephemeral``                          → don't persist codex's own session JSONL
                                              (we keep our own transcript file)
- ``--json``                               → emit JSONL events to stdout
- ``-m <model>``                           → model

Logger namespace: ``flow_sdk.builtin.agentic_process.cli_drivers.codex.cli`` so codex-CLI log
lines are easy to filter independently of the Claude CLI lines.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import WorkerCLIOptions
from flow_sdk.builtin.agentic_process.model_tiers import CODEX_MODEL_TIERS

logger = logging.getLogger(__name__)


class CodexCliOptions(WorkerCLIOptions):
    """Builds a ``codex exec`` shell command string.

    The intent is parity with ``ClaudeCliOptions`` so that the ``cmd_line``
    property on AgenticProcess returns something inspectable for codex too
    (the ``test_agentic_process_clock_agent`` test asserts on ``cmd_line``).
    """

    # sm/md/lg → gpt-5.4-mini/gpt-5.4/gpt-5.5, applied when emitting command.
    MODEL_TIERS = CODEX_MODEL_TIERS

    def __init__(
        self,
        session_id: str | None = None,
        resume: bool = False,
        model: str | None = None,
        permission_mode: str = "bypassPermissions",
        skill_names: list[str] | None = None,
        workdir: str | None = None,
        env_vars: dict[str, str] | None = None,
        add_dirs: list[str] | None = None,
        json_stream: bool = True,
        ephemeral: bool = True,
    ) -> None:
        super().__init__(workdir=workdir, env_vars=env_vars)
        self.session_id = session_id
        self.resume = resume
        self.model = model
        self.permission_mode = permission_mode
        # Codex doesn't support per-process inline agents the way Claude does.
        # We track skill names that the worker has materialized into ~/.codex/skills/
        # so the ``cmd_line`` representation reflects which skills are wired up.
        self.skill_names: list[str] = list(skill_names or [])
        self.add_dirs: list[str] = list(add_dirs or [])
        self.json_stream = json_stream
        self.ephemeral = ephemeral
        self.developer_instructions: str | None = None

    # Overridden per-process in ``_reasoning_effort_flags`` (see there for why).
    # Chosen to stay under the 30s test timeout — keep in sync if that's relaxed.
    DEFAULT_REASONING_EFFORT = "low"

    EXECUTABLE = "codex"
    PROMPT_CHANNEL = "stdin"  # codex reads the prompt from stdin (the `-` sentinel)
    SYSTEM_PROMPT_FLAG = None  # no flag — a system-prompt addition prepends into stdin

    def _common_tail(self) -> list[str]:
        """Flags shared by both transports: cwd, model, add-dirs, resume."""
        tail: list[str] = []
        if self.workdir:
            tail.extend(["-C", self.workdir])
        if self.resolved_model:
            tail.extend(["-m", self.resolved_model])
        for d in self.add_dirs:
            tail.extend(["--add-dir", d])
        if self.resume and self.session_id:
            tail.extend(["resume", self.session_id])  # positional subcommand, not a flag
        return tail

    def _developer_instruction_flags(self) -> list[str]:
        if not self.developer_instructions:
            return []
        return ["-c", f"developer_instructions={json.dumps(self.developer_instructions)}"]

    def _interactive_trust_flags(self) -> list[str]:
        """Trust the injected-input target only when full access was requested."""
        if self.permission_mode != "bypassPermissions" or not self.workdir:
            return []

        # The interactive directory-trust prompt consumes Flowpad's first
        # programmatic submission. Keep this override process-local and aligned
        # with the caller's explicit full-access permission choice. Codex
        # splits ``-c`` keys literally on dots, so a path cannot safely be a
        # dotted key segment. Supply the exact project path as TOML data in an
        # inline table instead. Match Codex's own lookup by canonicalizing an
        # existing workdir, while retaining the original path if that fails.
        try:
            workdir = str(Path(self.workdir).resolve(strict=True))
        except OSError:
            workdir = self.workdir
        # JSON and TOML basic strings share the escapes used here. JSON leaves
        # DEL (U+007F) raw, though TOML forbids it, so escape that one extra
        # codepoint while preserving non-BMP Unicode as real UTF-8.
        project = json.dumps(workdir, ensure_ascii=False).replace("\x7f", "\\u007f")
        trusted = json.dumps("trusted")
        return ["-c", f"projects={{{project}={{trust_level={trusted}}}}}"]

    def _interactive_update_flags(self) -> list[str]:
        """Keep Codex's startup updater out of automation-owned PTYs.

        A pending update otherwise replaces the composer with an interactive
        install/skip screen. Flowpad must never submit a user turn into that
        interstitial, and a process-local ``-c`` override avoids mutating the
        user's global Codex configuration.
        """
        return ["-c", "check_for_update_on_startup=false"]

    def _reasoning_effort_flags(self) -> list[str]:
        """Process-local reasoning-effort override — required on BOTH transports.

        Without it the turn inherits ``model_reasoning_effort`` from the user's
        global ~/.codex/config.toml. That is not merely slow: codex maps some
        values to an effort the API rejects outright (``ultra`` → ``max`` →
        HTTP 400 ``Invalid value: 'max'``), which fails the turn with no
        assistant message. A ``-c`` override is process-local, so the user's
        global config is never mutated (same technique as
        :meth:`_interactive_update_flags`).
        """
        return ["-c", f"model_reasoning_effort={self.DEFAULT_REASONING_EFFORT}"]

    def _emit_flags(self) -> list[str]:
        """argv after ``codex``. Two shapes keyed on ``json_stream``:
          * True (default) → ``exec … --json … -`` headless, prompt over stdin;
          * False → bare interactive TUI flags (PTY-attached visible tab).
        Both end with the shared :meth:`_common_tail`.
        """
        bypass = ["--dangerously-bypass-approvals-and-sandbox"] if self.permission_mode == "bypassPermissions" else []
        dev_flags = self._developer_instruction_flags()
        if not self.json_stream:
            return (
                bypass
                + self._interactive_update_flags()
                + self._interactive_trust_flags()
                + self._reasoning_effort_flags()
                + dev_flags
                + self._common_tail()
            )

        head = ["exec", "--skip-git-repo-check", *bypass]
        if self.ephemeral:
            head.append("--ephemeral")
        head.append("--json")
        head.extend(self._reasoning_effort_flags())
        return head + dev_flags + self._common_tail() + ["-"]  # trailing "-" → codex reads prompt from stdin

    def to_json(self) -> dict[str, Any]:
        d = super().to_json()
        d.update({
            "worker_type": "codex",
            "session_id": self.session_id,
            "resume": self.resume,
            "model": self.model,
            "permission_mode": self.permission_mode,
            "skill_names": self.skill_names,
            "add_dirs": self.add_dirs,
            "json_stream": self.json_stream,
            "ephemeral": self.ephemeral,
        })
        return d

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "CodexCliOptions":
        return cls(
            session_id=data.get("session_id"),
            resume=bool(data.get("resume", False)),
            model=data.get("model"),
            permission_mode=data.get("permission_mode", "bypassPermissions"),
            skill_names=list(data.get("skill_names") or []),
            workdir=data.get("workdir"),
            env_vars=data.get("env_vars") or {},
            add_dirs=list(data.get("add_dirs") or []),
            json_stream=bool(data.get("json_stream", True)),
            ephemeral=bool(data.get("ephemeral", True)),
        )
