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

    def apply_instruction_assets(self, assets: Any) -> None:
        """OpenCode's instruction channel is the generated config, not argv.

        The base's directory flags are meaningless here — there is no
        ``--add-dir`` and no custom-instruction dir — so the assets are turned
        into an ``opencode.json`` and reach the worker through
        ``OPENCODE_CONFIG``. Without this override an interactive (PTY) session
        received neither instructions nor skills: nothing else on any spawn path
        sets ``config_path``, so ``_sync_config_env`` was a silent no-op.
        """
        from .config_gen import config_for_assets_dir

        config = config_for_assets_dir(
            getattr(assets, "process_id", "") or "",
            getattr(assets, "assets_dir", None),
        )
        if config is not None:
            self.config_path = str(config)

    def _sync_config_env(self) -> None:
        """Point opencode at the generated per-process config.

        The copilot analogue (``_sync_custom_instruction_env``) exists for the
        same reason: the value is runtime-resolved, so it must be applied on
        every spawn path rather than baked into the persisted options.
        """
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

    def to_json(self) -> dict[str, Any]:
        data = super().to_json()
        data.update({
            "worker_type": "opencode",
            "session_id": self.session_id,
            "resume": self.resume,
            "fork_session_id": self.fork_session_id,
            "model": self.model,
            "permission_mode": self.permission_mode,
            "agent": self.agent,
            "variant": self.variant,
            "skill_names": self.skill_names,
            "add_dirs": self.add_dirs,
            "json_stream": self.json_stream,
        })
        return data

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "OpenCodeAgentOptions":
        return cls(
            session_id=data.get("session_id"),
            resume=bool(data.get("resume", False)),
            fork_session_id=data.get("fork_session_id"),
            model=data.get("model"),
            permission_mode=data.get("permission_mode", "bypassPermissions"),
            agent=data.get("agent"),
            variant=data.get("variant"),
            skill_names=list(data.get("skill_names") or []),
            workdir=data.get("workdir"),
            env_vars=data.get("env_vars") or {},
            add_dirs=list(data.get("add_dirs") or []),
            json_stream=bool(data.get("json_stream", True)),
        )


#: The options class ``factory`` builds for this vendor.
AGENT_OPTIONS = OpenCodeAgentOptions
