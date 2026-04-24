"""
ClaudeCLIWorker - Claude Code CLI execution via subprocess.

Implements AgenticWorker using ``asyncio.create_subprocess_exec`` to run
the ``claude`` binary.  This is the fallback execution path when
``claude_agent_sdk`` is not installed.

Design:
- ``build_args()`` and ``build_env()`` are pure functions that return the
  CLI invocation and environment dict — fully testable without running a
  subprocess.
- ``execute()`` calls those helpers, launches the process, and streams
  ``FlowData`` chunks from stdout.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shlex
import shutil
import uuid
from typing import Any, AsyncIterator

from flow_sdk.builtin.agentic_workers.base.context import AgenticContext
from flow_sdk.builtin.agentic_workers.base.worker import AgenticWorker
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData, FlowDataType, FlowElementType

logger = logging.getLogger(__name__)


class ClaudeCLIWorker(AgenticWorker):
    """Worker that executes Claude CLI via subprocess.

    Pure-subprocess implementation of the AgenticWorker interface.
    All configuration comes from ``AgenticContext``.
    """

    def __init__(self) -> None:
        self._session_id: str | None = None
        self._history: list[FlowData] = []

    # ------------------------------------------------------------------
    # Testable helpers
    # ------------------------------------------------------------------

    @staticmethod
    def find_claude_binary() -> str | None:
        """Locate the ``claude`` binary on PATH."""
        return shutil.which("claude")

    @staticmethod
    def build_args(
        claude_bin: str,
        prompt: str,
        session_id: str,
        context: AgenticContext,
        agents_json: dict[str, Any] | None = None,
    ) -> list[str]:
        """Build the CLI argument list.

        This is a pure function — no side effects, fully unit-testable.
        """
        args = [claude_bin]
        if context.permission_mode == "bypassPermissions":
            args.append("--dangerously-skip-permissions")
        args.extend(["--session-id", session_id])
        if context.model:
            args.extend(["--model", context.model])
        if agents_json:
            args.extend(["--agents", json.dumps(agents_json)])
        args.extend(["-p", prompt])
        return args

    @staticmethod
    def build_env(context: AgenticContext) -> dict[str, str]:
        """Build a sanitized environment dict for the subprocess.

        Starts from ``os.environ``, strips ``CLAUDECODE*`` vars, sets
        ``CLAUDE_PROJECT_DIR``, and overlays ``context.env_vars``.

        This is a pure-ish function (reads os.environ) — unit-testable.
        """
        env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDECODE")}
        env.update(context.env_vars)
        if context.workdir:
            env["CLAUDE_PROJECT_DIR"] = context.workdir
        return env

    # ------------------------------------------------------------------
    # AgenticWorker interface
    # ------------------------------------------------------------------

    async def execute(
        self,
        prompt: str,
        context: AgenticContext,
        agents_json: dict[str, Any] | None = None,
    ) -> AsyncIterator[FlowData]:
        """Execute prompt via ``claude`` CLI subprocess.

        Yields ``FlowData`` chunks: a STATUS on start, CHAT with the full
        stdout on completion, and ERROR if the process fails.
        """
        claude_bin = self.find_claude_binary()
        if not claude_bin:
            yield FlowData(
                flow_value="claude binary not found in PATH",
                attributes={
                    "element-type": FlowElementType.ERROR,
                    "data-type": FlowDataType.TEXT,
                },
            )
            return

        self._session_id = str(uuid.uuid4())
        args = self.build_args(claude_bin, prompt, self._session_id, context, agents_json=agents_json)
        env = self.build_env(context)

        logger.info(
            "ClaudeCLIWorker: launching %s",
            " ".join(shlex.quote(a) for a in args[1:]),
        )

        yield FlowData(
            flow_value=f"Starting claude CLI session {self._session_id}",
            attributes={
                "element-type": FlowElementType.STATUS,
                "data-type": FlowDataType.TEXT,
            },
        )

        try:
            proc = await asyncio.create_subprocess_exec(
                *args,
                cwd=context.workdir,
                env=env,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout_bytes, stderr_bytes = await proc.communicate()
            output = stdout_bytes.decode("utf-8", errors="replace")
            error_output = stderr_bytes.decode("utf-8", errors="replace")

            if output:
                fd = FlowData(
                    flow_value=output,
                    attributes={
                        "element-type": FlowElementType.CHAT,
                        "data-type": FlowDataType.TEXT,
                        "complete": "true",
                    },
                )
                self._history.append(fd)
                yield fd

            if proc.returncode != 0:
                err_msg = error_output or f"claude exited with code {proc.returncode}"
                yield FlowData(
                    flow_value=err_msg,
                    attributes={
                        "element-type": FlowElementType.ERROR,
                        "data-type": FlowDataType.TEXT,
                    },
                )

        except Exception as e:
            logger.error(f"ClaudeCLIWorker execution error: {e}", exc_info=True)
            yield FlowData(
                flow_value=f"Error: {e}",
                attributes={
                    "element-type": FlowElementType.ERROR,
                    "data-type": FlowDataType.TEXT,
                },
            )

    # ------------------------------------------------------------------
    # History interface
    # ------------------------------------------------------------------

    def get_session_id(self) -> str | None:
        return self._session_id

    def get_history(self) -> list[FlowData] | None:
        return self._history

    def set_history(self, history: list[FlowData]) -> None:
        self._history = history

    def manages_history(self) -> bool:
        return False
