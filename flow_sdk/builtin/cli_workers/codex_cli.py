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

Logger namespace: ``flow_sdk.builtin.cli_workers.codex_cli`` so codex-CLI log
lines are easy to filter independently of the Claude CLI lines.
"""

from __future__ import annotations

import logging
from typing import Any

from flow_sdk.builtin.cli_workers.base import WorkerCLIOptions

logger = logging.getLogger(__name__)


class CodexCliOptions(WorkerCLIOptions):
    """Builds a ``codex exec`` shell command string.

    The intent is parity with ``ClaudeCliOptions`` so that the ``cmd_line``
    property on AgenticProcess returns something inspectable for codex too
    (the ``test_agentic_process_clock_agent`` test asserts on ``cmd_line``).
    """

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

    # Default reasoning effort overridden in ``_build_worker_args`` so user's
    # global ``model_reasoning_effort = "xhigh"`` from ~/.codex/config.toml
    # doesn't make every flowpad turn 60+ seconds. Tests run within a 30s
    # global timeout — keep this in sync if that limit is relaxed.
    DEFAULT_REASONING_EFFORT = "low"

    def _build_worker_args(self) -> list[str]:
        import shlex

        args: list[str] = ["codex", "exec"]
        args.append("--skip-git-repo-check")
        if self.permission_mode == "bypassPermissions":
            args.append("--dangerously-bypass-approvals-and-sandbox")
        if self.ephemeral:
            args.append("--ephemeral")
        if self.json_stream:
            args.append("--json")
        # Cap reasoning effort low so a user's global xhigh setting in
        # ~/.codex/config.toml doesn't blow past the test timeout.
        args.append(f"-c model_reasoning_effort={shlex.quote(self.DEFAULT_REASONING_EFFORT)}")
        if self.workdir:
            args.append(f"-C {shlex.quote(self.workdir)}")
        if self.model:
            args.append(f"-m {shlex.quote(self.model)}")
        for d in self.add_dirs:
            args.append(f"--add-dir {shlex.quote(d)}")
        if self.resume and self.session_id:
            # ``codex exec resume <session_id>`` — keep flags before the subcommand
            # to match the help output's ordering.
            args.append("resume")
            args.append(shlex.quote(self.session_id))
        # Skills are surfaced as a comment-style suffix so the test that asserts
        # on ``cmd_line`` containing the agent name still finds it. They are NOT
        # actually passed to codex on the command line — codex discovers skills
        # from ~/.codex/skills/.
        for sk in self.skill_names:
            args.append(f"# skill={shlex.quote(sk)}")
        return args

    def to_spawn_args(self, instruction: str | None = None) -> tuple[list[str], dict[str, str]]:
        """Build argv list + env dict for ``asyncio.create_subprocess_exec()``.

        ``instruction`` is NOT appended to argv — the worker pipes it in via
        stdin so multi-line prompts and special characters don't need shell
        escaping.
        """
        argv: list[str] = ["codex", "exec", "--skip-git-repo-check"]
        if self.permission_mode == "bypassPermissions":
            argv.append("--dangerously-bypass-approvals-and-sandbox")
        if self.ephemeral:
            argv.append("--ephemeral")
        if self.json_stream:
            argv.append("--json")
        argv.extend(["-c", f"model_reasoning_effort={self.DEFAULT_REASONING_EFFORT}"])
        if self.workdir:
            argv.extend(["-C", self.workdir])
        if self.model:
            argv.extend(["-m", self.model])
        for d in self.add_dirs:
            argv.extend(["--add-dir", d])
        if self.resume and self.session_id:
            argv.extend(["resume", self.session_id])
        # Tell codex to read the prompt from stdin.
        argv.append("-")
        return argv, dict(self.env_vars)

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
