"""CodexCLIStreamWorker — non-interactive codex with per-event JSONL streaming.

Spawns ``codex exec --json --skip-git-repo-check
--dangerously-bypass-approvals-and-sandbox --ephemeral [-C workdir]`` as a
subprocess, pipes the prompt over stdin, and reads stdout line-by-line. Each
line is:
  - tee'd to a process-local transcript file (so AgenticProcess.stream_transcript
    and the codex tail-status helper can read it);
  - converted into FlowData via codex_event_to_flowdata.convert_line and
    yielded to the caller.

Session continuity:
- Captures the ``thread_id`` from the first ``thread.started`` event onto
  ``self._session_id`` so the AgenticProcess can persist it.
- Codex persists its own rollout under ``~/.codex/sessions/`` (NOT ``--ephemeral``)
  so a subsequent turn can ``codex exec ... resume <thread_id>``: that's the only
  store ``has_resumable_session``/``find_codex_session_jsonl`` can see, and it's
  the SAME rollout the PTY path writes — so headless multi-turn resumes, and a
  headless⇄PTY toggle keeps one continuous session. (We still tee the events into
  the process-local transcript for our own readers.)

Cancel semantics: ``close_session()`` sends SIGINT to the codex root process
first — the CLI winds the turn down itself (reaping its tool children, so the
stdout pipe reaches EOF promptly) and its rollout stays coherent for resume.
Only if codex doesn't exit within the existing ``CANCEL_GRACE_SECONDS`` does
the legacy SIGTERM → grace → SIGKILL tree teardown run. A user-requested
cancel is reported as the canonical turn-abort STATUS frame, not
``exit-error`` — genuine crashes still surface ``exit-error``.

Logger namespace: ``flow_sdk.builtin.agentic_process.cli_drivers.codex.stream_worker``
— deliberately distinct from the Claude worker so log filtering by namespace
gives clean separation between worker types.
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import AsyncIterator

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    STREAM_JSON_LINE_LIMIT_BYTES,
    AgenticContext,
    AgenticWorker,
    WorkerSpawnError,
    build_worker_spawn_env,
    interrupt_then_terminate_asyncio_process_tree,
    resolve_worker_argv0,
    stamp_cli_run_id,
    terminate_asyncio_process_tree,
    wait_for_asyncio_process_or_kill_tree,
)
from flow_sdk.builtin.agentic_process.cli_drivers.codex.cli import CodexAgentOptions
from flow_sdk.builtin.agentic_process.cli_drivers.codex.event_to_flowdata import (
    convert_line,
    final_end_frame,
)
from flow_sdk.builtin.agentic_process.cli_drivers.codex.session_history import (
    codex_transcript_path_for_process,
)
from flow_sdk.builtin.agentic_process.turn_abort import abort_status_frame
from flow_sdk.external_apis.llm.llm_drivers.flow_data import (
    FlowData,
    FlowDataType,
    FlowElementType,
)

logger = logging.getLogger(__name__)

CANCEL_GRACE_SECONDS = 5.0


class CodexCLIStreamWorker(AgenticWorker):
    """Streaming codex worker using ``codex exec --json``.

    One worker is spawned per turn from ``AgenticProcess._codex_prompt``.
    The transcript path is supplied by the caller so the worker can tee the
    JSONL stream to a known on-disk location.
    """

    def __init__(self, transcript_path: Path | str | None = None) -> None:
        self._session_id: str | None = None
        self._proc: asyncio.subprocess.Process | None = None
        self._process_run_id: str | None = None
        self._transcript_path: Path | None = Path(transcript_path) if transcript_path else None
        self._cancel_requested = False
        self._cancelled_gracefully = False

    @classmethod
    def for_process(cls, process_id: str) -> "CodexCLIStreamWorker":
        """Build a worker that writes its transcript under the process record dir."""
        return cls(transcript_path=codex_transcript_path_for_process(process_id))

    @property
    def transcript_path(self) -> Path | None:
        return self._transcript_path

    @property
    def cancelled_gracefully(self) -> bool:
        """True when SIGINT let codex wind its own turn down cleanly.

        The cancel choke point (``_http_cancel_prompt``) skips the flowpad abort
        sidecar marker in that case — a graceful SIGINT lets codex record its own
        ``event_msg.turn_aborted`` in the rollout, so a sidecar marker would
        replay as a DUPLICATE turn-terminated STATUS (``merge_abort_markers`` has
        no dedup). A force-killed codex records nothing, so the sidecar is kept.
        """
        return self._cancelled_gracefully

    async def execute(
        self,
        prompt: str,
        context: AgenticContext,
    ) -> AsyncIterator[FlowData]:
        self._process_run_id = None
        try:
            argv, env, stdin = self._build_spawn(context, prompt)
        except WorkerSpawnError as e:
            # Surface the message on the chat stream, then propagate so the
            # turn runner latches status=FAILED + start_failure.
            yield _error(str(e))
            raise

        logger.info("CodexCLIStreamWorker: launching %s", " ".join(argv))
        self._process_run_id = stamp_cli_run_id(env)

        # Open transcript file for tee'ing the JSONL stream.
        # Append mode keeps existing content if the worker is reused (rare).
        tee_fh = None
        if self._transcript_path is not None:
            try:
                self._transcript_path.parent.mkdir(parents=True, exist_ok=True)
                tee_fh = open(self._transcript_path, "ab", buffering=0)
            except OSError as e:
                logger.warning("CodexCLIStreamWorker: failed to open transcript %s: %s", self._transcript_path, e)

        try:
            self._proc = await asyncio.create_subprocess_exec(
                *argv,
                cwd=context.workdir,
                env=env,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                limit=STREAM_JSON_LINE_LIMIT_BYTES,
            )
        except Exception as e:
            logger.exception("CodexCLIStreamWorker: spawn failed")
            if tee_fh:
                tee_fh.close()
            message = f"spawn failed: {e}"
            yield _error(message)
            raise WorkerSpawnError("codex", message) from e

        # Pipe the prompt (with any system-prompt addition already prepended by
        # the options' stdin sink) in, and close stdin so codex starts processing.
        try:
            assert self._proc.stdin is not None
            self._proc.stdin.write((stdin or "").encode("utf-8"))
            await self._proc.stdin.drain()
            self._proc.stdin.close()
        except Exception as e:
            logger.warning("CodexCLIStreamWorker: stdin write failed: %s", e)

        stderr_task = asyncio.create_task(self._drain_stderr(self._proc))

        try:
            assert self._proc.stdout is not None
            async for raw_line in self._proc.stdout:
                if tee_fh is not None:
                    try:
                        tee_fh.write(raw_line)
                    except OSError:
                        pass
                decoded = raw_line.decode("utf-8", errors="replace")
                # Capture thread_id from the first ``thread.started`` event.
                if self._session_id is None:
                    sid = _maybe_extract_thread_id(decoded)
                    if sid:
                        self._session_id = sid
                for fd in convert_line(decoded):
                    yield fd
        except asyncio.CancelledError:
            await self._terminate_process()
            raise
        finally:
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

            if tee_fh is not None:
                try:
                    tee_fh.close()
                except Exception:
                    pass

            # If codex exited with a non-zero code without emitting turn.completed
            # we still owe the caller a clean END frame (mirrors Claude worker).
            # A user-requested cancel is not an error — report the canonical
            # turn-abort STATUS instead of ``exit-error``.
            if self._cancel_requested:
                yield abort_status_frame()
            elif self._proc and self._proc.returncode not in (0, None):
                yield _status(
                    "exit-error",
                    f"codex exited with code {self._proc.returncode}",
                )
            yield final_end_frame()

    async def close_session(self) -> None:
        """Stop the in-flight turn — SIGINT first, tree kill as backstop.

        SIGINT lets codex wind down its own turn (it reaps the tool child, so
        the stdout pipe reaches EOF immediately, and the rollout tail stays
        coherent for ``codex exec resume``). Anything that survives the
        existing ``CANCEL_GRACE_SECONDS`` — the root or a stray tool child —
        goes through the standard force-kill tree teardown (same budget the
        kill path already used — no new/raised timeout).
        """
        self._cancel_requested = True
        proc = self._proc
        if proc is None:
            return
        # A graceful SIGINT wind-down means codex recorded its own turn abort in
        # the rollout; the cancel choke point then skips the duplicate flowpad
        # sidecar marker (see the ``cancelled_gracefully`` property).
        self._cancelled_gracefully = await interrupt_then_terminate_asyncio_process_tree(
            proc,
            CANCEL_GRACE_SECONDS,
            run_id=self._process_run_id,
        )

    def get_session_id(self) -> str | None:
        return self._session_id

    def manages_history(self) -> bool:
        # Process-local transcript is read by codex_session_history.
        return True

    # ── Internals ─────────────────────────────────────────────────────────────

    def _build_spawn(
        self,
        context: AgenticContext,
        prompt: str,
    ) -> tuple[list[str], dict[str, str], str | None]:
        """Build the ``(argv, env, stdin)`` spawn tuple.

        Raises :class:`WorkerSpawnError` when codex is not installed (no
        harness capability discovered) or its executable can't be resolved on
        the spawn PATH.
        """
        opts = CodexAgentOptions(
            workdir=context.workdir,
            env_vars=dict(context.env_vars) if context.env_vars else None,
            model=context.model,
            permission_mode=context.permission_mode,
            session_id=context.resume_session_id,
            resume=bool(context.resume_session_id),
            json_stream=True,
            # NOT ephemeral: persist codex's rollout so the NEXT headless turn (or
            # a headless→PTY toggle) can resume this thread. Mirrors the PTY path
            # (driver.cmd_line sets ephemeral=False for visible). Without a rollout,
            # find_codex_session_jsonl misses → has_resumable_session=False → every
            # turn mints a fresh session_id (the headless multi-turn resume bug).
            ephemeral=False,
        )
        opts.add_dirs = list(context.add_dirs or [])
        opts.developer_instructions = context.developer_instructions
        opts.extra_config_overrides = list(context.extra_config_overrides or [])
        opts.bypass_hook_trust = context.bypass_hook_trust
        # Asset-backed system instructions ride developer_instructions; the
        # legacy system_prompt_append path remains unused for new launches.
        argv, env_from_opts, stdin = opts.to_spawn(instruction=prompt, system_prompt_append=context.instructions)

        # Inherit os.environ so codex can find creds, ~/.codex; overlay the
        # caller-provided env_vars (they win, except the discovered capability
        # bin folder stays first on PATH), then pin argv[0] to the discovered
        # absolute executable — the subprocess layer resolves a bare argv[0]
        # against the PARENT process PATH on some platforms, and a desktop
        # service PATH commonly lacks the nvm bin dir discovery recorded.
        env = build_worker_spawn_env("codex", env_from_opts)
        argv = resolve_worker_argv0("codex", argv, env)
        return argv, env, stdin

    async def _drain_stderr(self, proc: asyncio.subprocess.Process) -> None:
        if proc.stderr is None:
            return
        try:
            async for raw_line in proc.stderr:
                decoded = raw_line.decode("utf-8", errors="replace").rstrip()
                if decoded:
                    logger.debug("codex stderr: %s", decoded)
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.debug("stderr drain error", exc_info=True)

    async def _terminate_process(self) -> None:
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


def _maybe_extract_thread_id(raw_line: str) -> str | None:
    try:
        event = json.loads(raw_line)
    except json.JSONDecodeError:
        return None
    if not isinstance(event, dict):
        return None
    if event.get("type") != "thread.started":
        return None
    tid = event.get("thread_id")
    return tid if isinstance(tid, str) else None
