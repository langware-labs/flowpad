"""CodexAgentOptions — builds OpenAI Codex CLI shell command strings.

Mirrors the shape of ``ClaudeAgentOptions`` for the ``codex exec`` non-interactive
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

import logging
from pathlib import Path
from typing import Any

from flow_sdk.builtin.agentic_process.cli_drivers.cli_serialization import serialize_toml_cli_value
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import AgentOptions
from flow_sdk.builtin.agentic_process.model_tiers import CODEX_MODEL_TIERS

logger = logging.getLogger(__name__)


class CodexAgentOptions(AgentOptions):
    """Builds a ``codex exec`` shell command string.

    The intent is parity with ``ClaudeAgentOptions`` so that the ``cmd_line``
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
        bypass_hook_trust: bool = False,
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
        # `-c key=val` overrides for API-key auth (the OpenRouter provider block).
        # Derived per-spawn from the harness Capability — excluded from to_json /
        # the restart hash, same as fork/resume.
        self.extra_config_overrides: list[tuple[str, Any]] = []
        # Allows process-scoped command hooks for this launch only. Deliberately
        # absent from ``to_json`` / ``from_json`` so trust is never persisted.
        self.bypass_hook_trust = bypass_hook_trust

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
        value = serialize_toml_cli_value(self.developer_instructions)
        return ["-c", f"developer_instructions={value}"]

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
        projects = {workdir: {"trust_level": "trusted"}}
        return ["-c", f"projects={serialize_toml_cli_value(projects)}"]

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

    def _extra_config_override_flags(self) -> list[str]:
        """API-key auth provider block: process-local ``-c key=val`` overrides
        (e.g. the OpenRouter model_providers config). TOML-quoted like the other
        ``-c`` helpers; empty in device mode."""
        flags: list[str] = []
        for key, value in self.extra_config_overrides:
            flags.extend(["-c", f"{key}={serialize_toml_cli_value(value)}"])
        return flags

    def _emit_flags(self) -> list[str]:
        """argv after ``codex``. Two shapes keyed on ``json_stream``:
          * True (default) → ``exec … --json … -`` headless, prompt over stdin;
          * False → bare interactive TUI flags (PTY-attached visible tab).
        Both end with the shared :meth:`_common_tail`.
        """
        bypass = ["--dangerously-bypass-approvals-and-sandbox"] if self.permission_mode == "bypassPermissions" else []
        hook_trust = ["--dangerously-bypass-hook-trust"] if self.bypass_hook_trust else []
        dev_flags = self._developer_instruction_flags()
        extra_cfg = self._extra_config_override_flags()
        if not self.json_stream:
            return (
                hook_trust
                + bypass
                + self._interactive_update_flags()
                + self._interactive_trust_flags()
                + self._reasoning_effort_flags()
                + extra_cfg
                + dev_flags
                + self._common_tail()
            )

        head = ["exec", "--skip-git-repo-check", *hook_trust, *bypass]
        if self.ephemeral:
            head.append("--ephemeral")
        head.append("--json")
        head.extend(self._reasoning_effort_flags())
        head.extend(extra_cfg)
        return head + dev_flags + self._common_tail() + ["-"]  # trailing "-" → codex reads prompt from stdin

    # ── Serialisation ───────────────────────────────────────────────────────
    # The base AgentOptions.to_json / from_json do the work; this is the whole
    # declaration of this vendor's wire shape. Key names and value types are
    # frozen — see tests/unit/test_agent_options_serialization_golden.py.

    WORKER_TYPE = "codex"
    SERIALIZED_FIELDS = (
        "session_id",
        "resume",
        "model",
        "permission_mode",
        "skill_names",
        "add_dirs",
        "json_stream",
        "ephemeral",
    )
    _COERCE = {
        "resume": bool,
        "json_stream": bool,
        "ephemeral": bool,
        "skill_names": lambda v: list(v or []),
        "add_dirs": lambda v: list(v or []),
    }


#: The options class ``factory`` builds for this vendor.
AGENT_OPTIONS = CodexAgentOptions
