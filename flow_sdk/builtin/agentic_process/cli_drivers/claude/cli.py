"""ClaudeAgentOptions — builds Claude Code CLI shell command strings.

Extends AgentOptions with all Claude-specific switches:
session/resume, fork, model, debug, permissions, chrome, worktree, agents.

Auto-injects CLAUDE_PROJECT_DIR from workdir.
"""

from __future__ import annotations

import json
from typing import Any

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import AgentOptions
from flow_sdk.builtin.agentic_process.model_tiers import CLAUDE_MODEL_TIERS
from flow_sdk.config import PLATFORM_WIN32


class ClaudeAgentOptions(AgentOptions):
    """Builds a ``claude`` CLI shell command string for PTY injection.

    All fields map 1-to-1 to CLI flags. The command object is constructed
    at process creation time (or upsert time) with the intent baked in;
    ``open()`` adds runtime env vars via ``add_env()`` before calling
    ``to_shell_string()``.

    Example::

        cmd = ClaudeAgentOptions(session_id="abc-123", resume=True, workdir="/proj")
        cmd.add_env("FLOWPAD_EXECUTION_SCOPE", scope_json)
        shell_str = cmd.to_shell_string()
        # → cd '/proj' && CLAUDE_PROJECT_DIR='/proj' FLOWPAD_EXECUTION_SCOPE='...'
        #   claude --dangerously-skip-permissions --resume 'abc-123'

    Fork example::

        cmd = ClaudeAgentOptions(
            session_id="new-uuid",      # new worker_session_id
            resume=True,
            fork_session_id="src-uuid", # the session being forked from
        )
        # → claude ... --resume 'src-uuid' --fork-session --session-id 'new-uuid'
    """

    # sm/md/lg → haiku/sonnet/opus, applied when emitting the worker command.
    MODEL_TIERS = CLAUDE_MODEL_TIERS

    EXECUTABLE = "claude"
    PROMPT_CHANNEL = "argv"  # claude takes the prompt as a `-- <text>` positional
    SYSTEM_PROMPT_FLAG = "--append-system-prompt"
    SYSTEM_PROMPT_FILE_FLAG = "--append-system-prompt-file"

    def __init__(
        self,
        session_id: str | None = None,
        resume: bool = False,
        fork_session_id: str | None = None,
        model: str | None = None,
        debug: bool = False,
        debug_file: str | None = None,
        permission_mode: str = "bypassPermissions",
        chrome: bool = False,
        worktree: bool = False,
        agents_json: dict | None = None,
        workdir: str | None = None,
        env_vars: dict[str, str] | None = None,
        print_mode: bool = False,
        add_dirs: list[str] | None = None,
        output_format: str | None = None,
        verbose: bool = False,
        effort: str | None = None,
    ) -> None:
        super().__init__(workdir=workdir, env_vars=env_vars)
        self.session_id = session_id
        self.resume = resume
        self.fork_session_id = fork_session_id
        self.model = model
        self.debug = debug
        # ``--debug-file`` redirects the debug stream to a path WE own. Two
        # reasons that matters: the CLI's own ``~/.claude/debug/`` is pruned by
        # its ``.last-cleanup`` housekeeping (the log for the incident you want
        # is routinely gone by the time you look), and a redirected debug
        # stream leaves stderr empty — measured 0 bytes — so turning debug on
        # does not flood ``_drain_stderr``'s WARNING logging.
        self.debug_file = debug_file
        self.permission_mode = permission_mode
        self.chrome = chrome
        self.worktree = worktree
        self.agents_json = agents_json
        self.print_mode = print_mode
        self.add_dirs: list[str] = list(add_dirs or [])
        # One of {"text", "json", "stream-json"} or None for CLI default.
        self.output_format = output_format
        # Required by CLI when output_format == "stream-json"; harmless otherwise.
        self.verbose = verbose or output_format == "stream-json"
        # ``--effort {low|medium|high|xhigh|max}`` — caps the parent's
        # reasoning budget. Lower effort means snappier responses, useful for
        # the headless-orchestration path where the parent only needs to
        # dispatch to sub-agents and write a brief wrap-up.
        self.effort = effort

        # Auto-inject CLAUDE_PROJECT_DIR from workdir
        if workdir:
            self.env_vars.setdefault("CLAUDE_PROJECT_DIR", workdir)

    # ------------------------------------------------------------------
    # AgentOptions contract
    # ------------------------------------------------------------------

    def _resolve_binary(self) -> list[str]:
        """Resolve the ``claude`` argv prefix on PATH; wrap a win32 ``.cmd``/
        ``.bat`` launcher through COMSPEC so PtyProcess can exec it."""
        import os
        import shutil
        import sys

        resolved = shutil.which("claude")
        if sys.platform == PLATFORM_WIN32 and resolved and resolved.lower().endswith((".cmd", ".bat")):
            comspec = os.environ.get("COMSPEC") or "cmd.exe"
            return [comspec, "/c", resolved]
        return [resolved or "claude"]

    def _emit_flags(self) -> list[str]:
        """Claude's argv flags (after the binary, before the ``-- <instruction>``).
        Order is canonical-argv; the shell form re-places ``--add-dir`` below."""
        flags: list[str] = []
        if self.permission_mode == "bypassPermissions":
            flags.append("--dangerously-skip-permissions")
        elif self.permission_mode in ("plan", "default", "acceptEdits"):
            # ``plan`` is required for the model to call ``ExitPlanMode``.
            flags.extend(["--permission-mode", self.permission_mode])
        if self.chrome:
            flags.append("--chrome")
        if self.debug:
            flags.append("--debug")
        if self.debug_file:
            flags.extend(["--debug-file", self.debug_file])
        if self.worktree:
            flags.append("--worktree")
        if self.verbose:
            flags.append("--verbose")
        if self.output_format:
            flags.extend(["--output-format", self.output_format])
        if self.resume and self.session_id:
            if self.fork_session_id:
                # Fork: --resume <source> --fork-session --session-id <new>
                flags.extend(["--resume", self.fork_session_id, "--fork-session", "--session-id", self.session_id])
            else:
                flags.extend(["--resume", self.session_id])
        elif self.session_id:
            flags.extend(["--session-id", self.session_id])
        if self.resolved_model:
            flags.extend(["--model", self.resolved_model])
        if self.effort:
            flags.extend(["--effort", self.effort])
        if self.agents_json:
            flags.extend(["--agents", json.dumps(self.agents_json)])
        if self.print_mode:
            flags.append("-p")
        for d in self.add_dirs:
            flags.extend(["--add-dir", d])
        return flags

    def to_shell_string(self, instruction: str | None = None) -> str:
        """Shell form of the claude command. The shell ordering differs from argv
        (and between OSes) — a pre-existing claude quirk we reproduce exactly:

        * posix: ``--add-dir`` goes at the very end, AFTER the instruction (the
          CLI registers skills only when add-dir trails the prompt here);
        * win32: ``--add-dir`` stays inline, before ``-p`` and the instruction.

        Both derive from ``_emit_flags`` (the single argv source) — no second
        flag list."""
        import shlex
        import sys

        p_flag: list[str] = []
        add_dir: list[str] = []
        rest: list[str] = []
        flags = self._emit_flags()
        i = 0
        while i < len(flags):
            if flags[i] == "--add-dir" and i + 1 < len(flags):
                add_dir.extend(flags[i : i + 2])
                i += 2
            elif flags[i] == "-p":
                p_flag.append("-p")
                i += 1
            else:
                rest.append(flags[i])
                i += 1

        # Launch-derived instructions ride the shell form too — the PTY spawn
        # is exactly this string, and the interactive CLI accepts the flag.
        if self.system_prompt_file and self.SYSTEM_PROMPT_FILE_FLAG:
            rest.extend([self.SYSTEM_PROMPT_FILE_FLAG, self.system_prompt_file])
        if self.system_prompt_append and self.SYSTEM_PROMPT_FLAG:
            rest.extend([self.SYSTEM_PROMPT_FLAG, self.system_prompt_append])

        def q(xs: list[str]) -> list[str]:
            return [shlex.quote(x) for x in xs]

        if sys.platform == "win32":
            return self._build_win32(["claude", *q(rest), *q(add_dir), *p_flag], instruction)
        cmd = self._build_posix(["claude", *q(rest), *p_flag], instruction)
        if add_dir:
            cmd += " " + " ".join(q(add_dir))
        return cmd

    # ------------------------------------------------------------------
    # Serialisation
    # ------------------------------------------------------------------

    def to_json(self) -> dict[str, Any]:
        d = super().to_json()
        d.update(
            {
                "worker_type": "claude",
                "session_id": self.session_id,
                "resume": self.resume,
                "fork_session_id": self.fork_session_id,
                "model": self.model,
                "debug": self.debug,
                "debug_file": self.debug_file,
                "permission_mode": self.permission_mode,
                "chrome": self.chrome,
                "worktree": self.worktree,
                "agents_json": self.agents_json,
                "print_mode": self.print_mode,
                "add_dirs": self.add_dirs,
                "output_format": self.output_format,
                "verbose": self.verbose,
                "effort": self.effort,
            }
        )
        return d

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "ClaudeAgentOptions":
        return cls(
            session_id=data.get("session_id"),
            resume=bool(data.get("resume", False)),
            fork_session_id=data.get("fork_session_id"),
            model=data.get("model"),
            debug=bool(data.get("debug", False)),
            debug_file=data.get("debug_file"),
            permission_mode=data.get("permission_mode", "bypassPermissions"),
            chrome=bool(data.get("chrome", False)),
            worktree=bool(data.get("worktree", False)),
            agents_json=data.get("agents_json"),
            workdir=data.get("workdir"),
            env_vars=data.get("env_vars") or {},
            print_mode=bool(data.get("print_mode", False)),
            add_dirs=list(data.get("add_dirs") or []),
            output_format=data.get("output_format"),
            verbose=bool(data.get("verbose", False)),
            effort=data.get("effort"),
        )
