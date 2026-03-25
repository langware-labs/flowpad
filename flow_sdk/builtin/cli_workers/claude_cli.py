"""ClaudeCLICommand — builds Claude Code CLI shell command strings.

Extends WorkerCLICommand with all Claude-specific switches:
session/resume, fork, model, debug, permissions, chrome, worktree, agents.

Auto-injects CLAUDE_PROJECT_DIR from workdir.
"""

from __future__ import annotations

import json
from typing import Any

from flow_sdk.builtin.cli_workers.base import WorkerCLICommand


class ClaudeCLICommand(WorkerCLICommand):
    """Builds a ``claude`` CLI shell command string for PTY injection.

    All fields map 1-to-1 to CLI flags. The command object is constructed
    at process creation time (or upsert time) with the intent baked in;
    ``open()`` adds runtime env vars via ``add_env()`` before calling
    ``to_shell_string()``.

    Example::

        cmd = ClaudeCLICommand(session_id="abc-123", resume=True, workdir="/proj")
        cmd.add_env("FLOWPAD_EXECUTION_SCOPE", scope_json)
        shell_str = cmd.to_shell_string()
        # → cd '/proj' && CLAUDE_PROJECT_DIR='/proj' FLOWPAD_EXECUTION_SCOPE='...'
        #   claude --dangerously-skip-permissions --debug --resume 'abc-123'

    Fork example::

        cmd = ClaudeCLICommand(
            session_id="new-uuid",      # new worker_session_id
            resume=True,
            fork_session_id="src-uuid", # the session being forked from
        )
        # → claude ... --resume 'src-uuid' --fork-session --session-id 'new-uuid'
    """

    def __init__(
        self,
        session_id: str | None = None,
        resume: bool = False,
        fork_session_id: str | None = None,
        model: str | None = None,
        debug: bool = True,
        permission_mode: str = "bypassPermissions",
        chrome: bool = False,
        worktree: bool = False,
        agents_json: dict | None = None,
        workdir: str | None = None,
        env_vars: dict[str, str] | None = None,
    ) -> None:
        super().__init__(workdir=workdir, env_vars=env_vars)
        self.session_id = session_id
        self.resume = resume
        self.fork_session_id = fork_session_id
        self.model = model
        self.debug = debug
        self.permission_mode = permission_mode
        self.chrome = chrome
        self.worktree = worktree
        self.agents_json = agents_json

        # Auto-inject CLAUDE_PROJECT_DIR from workdir
        if workdir:
            self.env_vars.setdefault("CLAUDE_PROJECT_DIR", workdir)

    # ------------------------------------------------------------------
    # WorkerCLICommand contract
    # ------------------------------------------------------------------

    def _build_worker_args(self) -> list[str]:
        import shlex

        args: list[str] = ["claude"]

        if self.permission_mode == "bypassPermissions":
            args.append("--dangerously-skip-permissions")
        if self.chrome:
            args.append("--chrome")
        if self.debug:
            args.append("--debug")
        if self.worktree:
            args.append("--worktree")

        if self.resume and self.session_id:
            args.append(f"--resume {shlex.quote(self.session_id)}")
            if self.fork_session_id:
                args.append("--fork-session")
                args.append(f"--session-id {shlex.quote(self.fork_session_id)}")
        elif self.session_id:
            args.append(f"--session-id {shlex.quote(self.session_id)}")

        if self.model:
            args.append(f"--model {shlex.quote(self.model)}")
        if self.agents_json:
            args.append(f"--agents {shlex.quote(json.dumps(self.agents_json))}")

        return args

    # ------------------------------------------------------------------
    # Serialisation
    # ------------------------------------------------------------------

    def to_json(self) -> dict[str, Any]:
        d = super().to_json()
        d.update({
            "worker_type": "claude",
            "session_id": self.session_id,
            "resume": self.resume,
            "fork_session_id": self.fork_session_id,
            "model": self.model,
            "debug": self.debug,
            "permission_mode": self.permission_mode,
            "chrome": self.chrome,
            "worktree": self.worktree,
            "agents_json": self.agents_json,
        })
        return d

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "ClaudeCLICommand":
        return cls(
            session_id=data.get("session_id"),
            resume=bool(data.get("resume", False)),
            fork_session_id=data.get("fork_session_id"),
            model=data.get("model"),
            debug=bool(data.get("debug", True)),
            permission_mode=data.get("permission_mode", "bypassPermissions"),
            chrome=bool(data.get("chrome", False)),
            worktree=bool(data.get("worktree", False)),
            agents_json=data.get("agents_json"),
            workdir=data.get("workdir"),
            env_vars=data.get("env_vars") or {},
        )
