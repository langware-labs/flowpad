"""OpenCode CLI command builder.

Two argv shapes keyed on ``json_stream``, mirroring codex/copilot: the headless
``opencode run … --format json`` stream, and the bare interactive TUI.

Two things are deliberately unlike the other vendors, both measured against
opencode 1.18.16:

* **There is no ``--add-dir``.** Extra roots and the generated instruction file
  reach the worker through a per-process config file pointed at by
  ``OPENCODE_CONFIG`` (see :mod:`.config_gen`), not through argv.

* **The two shapes do not share a flag surface.** ``opencode run`` accepts
  ``--dir`` and ``--variant``; the bare TUI (``opencode [project]``) accepts
  NEITHER — it takes the directory as a positional, and an unknown flag makes
  yargs print usage and exit 1. Anything emitted for both transports must exist
  on both, so check ``opencode --help`` as well as ``opencode run --help``.
* **OpenRouter needs no provider config.** opencode resolves it from a bare
  ``OPENROUTER_API_KEY`` in the spawn environment, so no key is ever written to
  disk and the generated config carries only instructions/skills.
"""

from __future__ import annotations

from typing import Any

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import AgentOptions
from flow_sdk.builtin.agentic_process.model_tiers import OPENCODE_MODEL_TIERS


class OpenCodeAgentOptions(AgentOptions):
    """Builds OpenCode CLI argv for headless JSON streaming or visible PTY mode."""

    # sm/md/lg → provider-qualified open-model slugs, applied when emitting the
    # worker command. Every opencode model id carries its provider prefix.
    MODEL_TIERS = OPENCODE_MODEL_TIERS

    EXECUTABLE = "opencode"
    # ``opencode run [message..]`` takes the prompt as a positional; there is no
    # stdin prompt channel.
    PROMPT_CHANNEL = "argv"
    # No inline system-prompt flag — instructions ride the generated config.
    SYSTEM_PROMPT_FLAG = None

    def __init__(
        self,
        session_id: str | None = None,
        resume: bool = False,
        fork_session_id: str | None = None,
        model: str | None = None,
        permission_mode: str = "bypassPermissions",
        agent: str | None = None,
        variant: str | None = None,
        skill_names: list[str] | None = None,
        workdir: str | None = None,
        env_vars: dict[str, str] | None = None,
        add_dirs: list[str] | None = None,
        json_stream: bool = True,
        config_path: str | None = None,
    ) -> None:
        super().__init__(workdir=workdir, env_vars=env_vars)
        self.session_id = session_id
        self.resume = resume
        # opencode's ``--fork`` requires --session/--continue, so a fork is a
        # resume that branches. Unlike claude the new id is minted by the CLI.
        self.fork_session_id = fork_session_id
        self.model = model
        self.permission_mode = permission_mode
        self.agent = agent
        self.variant = variant
        self.skill_names: list[str] = list(skill_names or [])
        self.add_dirs: list[str] = list(add_dirs or [])
        self.json_stream = json_stream
        self.config_path = config_path
        # Remembered by ``apply_process_mcp`` for the deferred fallback write in
        # ``_sync_config_env``. Launch-time only — never serialized.
        self._config_process_id = ""

    # ------------------------------------------------------------------
    # AgentOptions contract
    # ------------------------------------------------------------------

    def _auto_enabled(self) -> bool:
        """``--auto`` is opencode's bypass-permissions equivalent."""
        return self.permission_mode == "bypassPermissions"

    def _common_tail(self) -> list[str]:
        """Flags shared by both transports: model, agent, session.

        The working directory is deliberately NOT here — the two shapes spell it
        differently (see :meth:`_emit_flags`).
        """
        tail: list[str] = []
        if self.resolved_model:
            tail.extend(["--model", self.resolved_model])
        if self.agent:
            tail.extend(["--agent", self.agent])
        # ``--variant`` is a ``run``-only flag: the bare TUI's parser rejects it
        # (usage dump, exit 1), so it is emitted from the headless shape only.
        if self.variant and self.json_stream:
            tail.extend(["--variant", self.variant])
        # ``--session <id>`` CONTINUES an existing session; opencode exits 1 with
        # "Session not found" for an unknown id, so callers must gate on
        # ``has_resumable_session`` before setting resume.
        if self.resume and self.session_id:
            tail.extend(["--session", self.session_id])
            if self.fork_session_id:
                tail.append("--fork")
        return tail

    def _emit_flags(self) -> list[str]:
        """argv after ``opencode``. Two shapes keyed on ``json_stream``.

        The workdir is spelled differently per shape, measured against opencode
        1.18.16: ``opencode run`` takes ``--dir <path>``, but the bare TUI is
        ``opencode [project]`` — a POSITIONAL, with no ``--dir`` flag at all.
        Passing ``--dir`` to the TUI makes yargs dump usage and exit 1, so the
        PTY worker would die before ever painting its composer.
        """
        auto = ["--auto"] if self._auto_enabled() else []
        workdir = [self.workdir] if self.workdir else []
        if not self.json_stream:
            # Interactive TUI: bare ``opencode [project]`` plus the shared tail.
            return auto + workdir + self._common_tail()
        dir_flag = ["--dir", self.workdir] if self.workdir else []
        return ["run", "--format", "json", *auto, *dir_flag, *self._common_tail()]

    def _regenerate_config(self, process_id: str, assets_dir: Any = None) -> None:
        """Write this process's ``opencode.json`` and point ``config_path`` at it.

        The single owner of that write. ``mcp_config_fragment`` and ``add_dirs``
        are read off ``self``, so every caller only supplies what it knows.
        """
        if not process_id:
            return
        from .config_gen import config_for_assets_dir

        config = config_for_assets_dir(
            process_id, assets_dir, self.mcp_config_fragment, self.add_dirs
        )
        if config is not None:
            self.config_path = str(config)

    def apply_instruction_assets(self, assets: Any) -> None:
        """OpenCode's instruction channel is the generated config, not argv.

        The base's directory flags are meaningless here — there is no
        ``--add-dir`` and no custom-instruction dir — so the assets are turned
        into an ``opencode.json`` and reach the worker through
        ``OPENCODE_CONFIG``. Without this override an interactive (PTY) session
        received neither instructions nor skills: nothing else on any spawn path
        sets ``config_path``, so ``_sync_config_env`` was a silent no-op.

        ``self.add_dirs`` rides along for the same reason: it is set by the
        driver from ``resolved_add_dirs`` and has no other way out of this class.
        """
        self._regenerate_config(
            getattr(assets, "process_id", "") or "", getattr(assets, "assets_dir", None)
        )

    def apply_process_mcp(self, runtime: "Any", process_id: str = "") -> None:
        """Fold the rendered MCP into the generated config.

        Called by ``AgenticProcess._apply_process_assets`` BEFORE the instruction
        assets, so it only REMEMBERS the process id — writing here too would
        emit a config that ``apply_instruction_assets`` immediately overwrites
        with the superset. A process with servers or mounted roots and no
        instruction assets never reaches that override, so ``_sync_config_env``
        writes the fallback at spawn instead. Either way: one write, one owner.
        """
        super().apply_process_mcp(runtime, process_id)
        if process_id:
            self._config_process_id = process_id

    def _sync_config_env(self) -> None:
        """Point opencode at the generated per-process config.

        The copilot analogue (``_sync_custom_instruction_env``) exists for the
        same reason: the value is runtime-resolved, so it must be applied on
        every spawn path rather than baked into the persisted options.
        """
        if not self.config_path:
            # Servers and/or mounted roots but no instruction assets — the
            # fallback ``apply_process_mcp`` deferred to here.
            self._regenerate_config(self._config_process_id)
        if self.config_path:
            self.env_vars["OPENCODE_CONFIG"] = self.config_path

    def to_spawn(
        self, instruction: str | None = None, system_prompt_append: str | None = None
    ) -> tuple[list[str], dict[str, str], str | None]:
        self._sync_config_env()
        return super().to_spawn(instruction=instruction, system_prompt_append=system_prompt_append)

    def to_spawn_args(self, instruction: str | None = None) -> tuple[list[str], dict[str, str]]:
        self._sync_config_env()
        return super().to_spawn_args(instruction=instruction)

    def to_shell_string(self, instruction: str | None = None) -> str:
        self._sync_config_env()
        return super().to_shell_string(instruction=instruction)

    # ── Serialisation ───────────────────────────────────────────────────────
    # The base AgentOptions.to_json / from_json do the work; this is the whole
    # declaration of this vendor's wire shape. Key names and value types are
    # frozen — see tests/unit/test_agent_options_serialization_golden.py.

    WORKER_TYPE = "opencode"
    SERIALIZED_FIELDS = (
        "session_id",
        "resume",
        "fork_session_id",
        "model",
        "permission_mode",
        "agent",
        "variant",
        "skill_names",
        "add_dirs",
        "json_stream",
    )
    _COERCE = {
        "resume": bool,
        "json_stream": bool,
        "skill_names": lambda v: list(v or []),
        "add_dirs": lambda v: list(v or []),
    }


#: The options class ``factory`` builds for this vendor.
AGENT_OPTIONS = OpenCodeAgentOptions
