"""ClaudeCLIStreamWorker — print-mode Claude Code with per-event streaming.

Spawns ``claude -p --output-format stream-json --verbose`` as a subprocess,
reads stdout line-by-line, converts each JSON event into FlowData via
``claude_event_to_flowdata.convert_line``, and yields it to the caller.

Contrast with ``claude_cli_worker.ClaudeCLIWorker`` (sibling) which uses
``proc.communicate()`` — fully buffered, emits one CHAT block at the end.
This worker is the one used by the ``AgenticProcess.prompt`` action for
chat surfaces that need live FlowData.

Session continuity:
- If ``context.resume_session_id`` is set, passes ``--resume <sid>``. Claude
  continues the existing JSONL.
- Otherwise lets Claude generate a fresh session id. The first ``system:init``
  event on the stream carries it; we capture it onto ``self._session_id`` so
  callers can persist it on the AgenticProcess for the next turn.

Cancel semantics (per plan Q6):
- ``close_session()`` sends SIGTERM → 5 s grace → SIGKILL. ``execute()`` then
  emits a final ``<flow-end>`` so downstream consumers see a clean terminator.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import AsyncIterator

from flow_sdk.builtin.agentic_process.cli_drivers.claude.cli import ClaudeCliOptions
from flow_sdk.builtin.agentic_process.cli_drivers.claude.event_to_flowdata import (
    convert_line,
    final_end_frame,
)
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    STREAM_JSON_LINE_LIMIT_BYTES,
    AgenticContext,
    AgenticWorker,
    stamp_cli_run_id,
    terminate_asyncio_process_tree,
    wait_for_asyncio_process_or_kill_tree,
    worker_path_env,
)
from flow_sdk.external_apis.llm.llm_drivers.flow_data import (
    FlowData,
    FlowDataType,
    FlowElementType,
)

logger = logging.getLogger(__name__)

# Grace period before escalating SIGTERM → SIGKILL. Keep under the UI's cancel
# timeout (~10 s) so a stuck subprocess never wedges the chat.
CANCEL_GRACE_SECONDS = 5.0

class ClaudeCLIStreamWorker(AgenticWorker):
    """Streaming Claude CLI worker using ``--output-format stream-json``.

    The class is intentionally stateless beyond ``_session_id`` and ``_proc``
    so callers can reuse a single instance across turns if they want, but the
    default usage is one-instance-per-turn (spawned by ``AgenticProcess.prompt``).
    """

    def __init__(self) -> None:
        self._session_id: str | None = None
        self._proc: asyncio.subprocess.Process | None = None
        self._process_run_id: str | None = None

    # ── AgenticWorker contract ────────────────────────────────────────────────

    async def execute(
        self,
        prompt: str,
        context: AgenticContext,
    ) -> AsyncIterator[FlowData]:
        self._process_run_id = None
        argv, env = self._build_spawn(prompt, context)
        if argv is None:
            yield _error("claude binary not found in PATH")
            return

        logger.info("ClaudeCLIStreamWorker: launching %s", " ".join(argv))
        self._process_run_id = stamp_cli_run_id(env)

        try:
            self._proc = await asyncio.create_subprocess_exec(
                *argv,
                cwd=context.workdir,
                env=env,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                limit=STREAM_JSON_LINE_LIMIT_BYTES,
            )
        except Exception as e:
            logger.exception("ClaudeCLIStreamWorker: spawn failed")
            yield _error(f"spawn failed: {e}")
            return

        # Drain stderr in the background so the OS pipe buffer never fills.
        stderr_task = asyncio.create_task(self._drain_stderr(self._proc))

        try:
            assert self._proc.stdout is not None
            async for line in self._proc.stdout:
                # ``line`` is bytes including the trailing newline.
                decoded = line.decode("utf-8", errors="replace")
                for fd in convert_line(decoded):
                    # Capture session_id from the first ``system:init`` event.
                    if self._session_id is None and fd.attributes.get("subtype") == "init":
                        sid = _extract_session_id(decoded)
                        if sid:
                            self._session_id = sid
                    yield fd
        except asyncio.CancelledError:
            # Caller cancelled the async iteration — propagate after cleanup.
            await self._terminate_process()
            raise
        finally:
            # Always wait for the subprocess to settle so we don't leak zombies.
            if self._proc:
                await wait_for_asyncio_process_or_kill_tree(
                    self._proc,
                    CANCEL_GRACE_SECONDS,
                    run_id=self._process_run_id,
                )

            stderr_task.cancel()
            try:
                await stderr_task
            except asyncio.CancelledError:
                pass

            # If Claude exited cleanly without emitting a ``result`` event (which
            # would have produced ``<flow-end>`` via the converter), emit our own
            # terminator so downstream parsers always see a close.
            # The converter emits END after RESULT; if Claude crashed or was
            # killed before RESULT, we still owe the consumer an END frame.
            if self._proc and self._proc.returncode != 0:
                yield _status(
                    "exit-error",
                    f"claude exited with code {self._proc.returncode}",
                )
            yield final_end_frame()

    async def close_session(self) -> None:
        """Signal the live subprocess to terminate."""
        await self._terminate_process()

    def get_session_id(self) -> str | None:
        return self._session_id

    def manages_history(self) -> bool:
        # Claude writes its own JSONL; session_history.load_session_history
        # rehydrates from it on demand.
        return True

    # ── Internals ─────────────────────────────────────────────────────────────

    def _build_spawn(
        self,
        prompt: str,
        context: AgenticContext,
    ) -> tuple[list[str] | None, dict[str, str]]:
        """Build argv + env via the standard ``ClaudeCliOptions`` abstraction."""
        # Discovered harness capability supplies the CLI's bin folder
        # (terminal-PATH resolution) — None ⇔ claude is not installed.
        path_env = worker_path_env("claude")
        if path_env is None:
            return None, {}

        # Resume takes priority — when ``resume_session_id`` is set, attach
        # ``--resume <sid>``. Otherwise honour ``context.session_id`` (a
        # pre-allocated UUID the caller wants Claude to use) so transcript
        # discovery doesn't race the first ``system:init`` event.
        #
        # Fork (``--resume <source> --fork-session --session-id <new>``):
        # ``ClaudeCliOptions`` wants ``session_id=<new>`` and
        # ``fork_session_id=<source>``. Mapping from ``AgenticContext`` puts
        # the source on ``resume_session_id`` and the new id on ``session_id``.
        resume_sid = context.resume_session_id
        fresh_sid = context.session_id if not resume_sid else None
        is_fork = bool(context.fork_session and resume_sid and context.session_id)
        if is_fork:
            opts_session_id = context.session_id  # new id
            opts_fork_source = resume_sid  # source id
        else:
            opts_session_id = resume_sid or fresh_sid
            opts_fork_source = None
        # NOTE: this is deliberately NOT ``driver.cli_options(process)``. The
        # headless per-turn spawn is an intentionally different shape from the
        # general/PTY options ``cmd_line`` reports: it forces the sonnet parent
        # (opus's parent latency blows the long-test budget), ``--print``/
        # stream-json transport, and relies on process instruction assets for
        # embedded-agent/persona content. Codex's equivalent forces
        # ``ephemeral=False`` so resume works. Do not "unify" these two
        # construction points — you'd regress model latency and resume behavior.
        opts = ClaudeCliOptions(
            workdir=context.workdir,
            env_vars=dict(context.env_vars) if context.env_vars else None,
            model=context.model,
            permission_mode=context.permission_mode,
            session_id=opts_session_id,
            resume=bool(resume_sid),
            fork_session_id=opts_fork_source,
            output_format="stream-json",
            print_mode=True,
            effort=context.effort,
            add_dirs=list(context.add_dirs),
            # verbose=True is auto-enabled by ClaudeCliOptions when
            # output_format == "stream-json".
        )
        opts.system_prompt_file = context.system_prompt_file
        argv = opts.cli_cmd(instruction=prompt, system_prompt_append=context.instructions)
        env_from_opts = dict(opts.env_vars)

        # Start from os.environ so the CLI can find its creds, PATH, home.
        # Strip CLAUDECODE* to avoid the CLI thinking it's already inside a
        # Claude run. Overlay context env_vars last so callers win.
        env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDECODE")}
        env.update(path_env)  # capability bin-folder PATH prepend
        env.update(env_from_opts)
        return argv, env

    async def _drain_stderr(self, proc: asyncio.subprocess.Process) -> None:
        """Read and log stderr so the pipe buffer never fills.

        stderr is verbose in ``--debug`` mode; in the default path it's mostly
        empty. We log at DEBUG level so it's visible during investigation but
        doesn't clutter normal runs.
        """
        if proc.stderr is None:
            return
        try:
            async for line in proc.stderr:
                decoded = line.decode("utf-8", errors="replace").rstrip()
                if decoded:
                    logger.warning("claude stderr: %s", decoded)
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.warning("stderr drain error", exc_info=True)

    async def _terminate_process(self) -> None:
        """SIGTERM → grace → SIGKILL. Safe to call multiple times."""
        proc = self._proc
        if proc is None:
            return
        await terminate_asyncio_process_tree(
            proc,
            CANCEL_GRACE_SECONDS,
            run_id=self._process_run_id,
        )


# ── Module helpers ────────────────────────────────────────────────────────────


def _error(message: str) -> FlowData:
    return FlowData(
        flow_value=message,
        attributes={
            "element-type": FlowElementType.ERROR,
            "data-type": FlowDataType.TEXT,
        },
    )


def _status(subtype: str, value: str = "") -> FlowData:
    return FlowData(
        flow_value=value,
        attributes={
            "element-type": FlowElementType.STATUS,
            "data-type": FlowDataType.TEXT,
            "subtype": subtype,
        },
    )


def _extract_session_id(raw_line: str) -> str | None:
    """Best-effort session_id extraction from a ``system:init`` JSON line.

    Kept separate from the main converter so the converter stays purely shape-
    driven and this worker-specific concern doesn't leak.
    """
    import json
    try:
        event = json.loads(raw_line)
    except json.JSONDecodeError:
        return None
    sid = event.get("session_id")
    return sid if isinstance(sid, str) else None
