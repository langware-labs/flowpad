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
- ``--ephemeral`` is set so codex does not persist its own session JSONL —
  the process-local transcript is the source of truth.

Cancel semantics: ``close_session()`` sends SIGTERM → 5 s grace → SIGKILL,
matching the Claude worker's contract.

Logger namespace: ``flow_sdk.builtin.agentic_workers.codex_worker.stream_worker``
— deliberately distinct from the Claude worker so log filtering by namespace
gives clean separation between worker types.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
from pathlib import Path
from typing import AsyncIterator

from flow_sdk.builtin.agentic_workers.base.context import AgenticContext
from flow_sdk.builtin.agentic_workers.base.worker import AgenticWorker
from flow_sdk.builtin.agentic_workers.codex_worker.cli import CodexCliOptions
from flow_sdk.builtin.agentic_workers.codex_worker.event_to_flowdata import (
    convert_line,
    final_end_frame,
)
from flow_sdk.builtin.agentic_workers.codex_worker.session_history import (
    codex_transcript_path_for_process,
)
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
        self._transcript_path: Path | None = (
            Path(transcript_path) if transcript_path else None
        )

    @classmethod
    def for_process(cls, process_id: str) -> "CodexCLIStreamWorker":
        """Build a worker that writes its transcript under the process record dir."""
        return cls(transcript_path=codex_transcript_path_for_process(process_id))

    @property
    def transcript_path(self) -> Path | None:
        return self._transcript_path

    async def execute(
        self,
        prompt: str,
        context: AgenticContext,
    ) -> AsyncIterator[FlowData]:
        argv, env = self._build_spawn(context)
        if argv is None:
            yield _error("codex binary not found in PATH")
            return

        logger.info("CodexCLIStreamWorker: launching %s", " ".join(argv))

        # Open transcript file for tee'ing the JSONL stream.
        # Append mode keeps existing content if the worker is reused (rare).
        tee_fh = None
        if self._transcript_path is not None:
            try:
                self._transcript_path.parent.mkdir(parents=True, exist_ok=True)
                tee_fh = open(self._transcript_path, "ab", buffering=0)
            except OSError as e:
                logger.warning("CodexCLIStreamWorker: failed to open transcript %s: %s",
                               self._transcript_path, e)

        try:
            self._proc = await asyncio.create_subprocess_exec(
                *argv,
                cwd=context.workdir,
                env=env,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except Exception as e:
            logger.exception("CodexCLIStreamWorker: spawn failed")
            if tee_fh:
                tee_fh.close()
            yield _error(f"spawn failed: {e}")
            return

        # Pipe the prompt in and close stdin so codex starts processing.
        try:
            assert self._proc.stdin is not None
            self._proc.stdin.write(prompt.encode("utf-8"))
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
            if self._proc and self._proc.returncode is None:
                try:
                    await asyncio.wait_for(self._proc.wait(), timeout=CANCEL_GRACE_SECONDS)
                except asyncio.TimeoutError:
                    logger.warning(
                        "CodexCLIStreamWorker: subprocess did not exit in grace; sending SIGKILL"
                    )
                    self._proc.kill()
                    await self._proc.wait()

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
            if self._proc and self._proc.returncode not in (0, None):
                yield _status(
                    "exit-error",
                    f"codex exited with code {self._proc.returncode}",
                )
            yield final_end_frame()

    async def close_session(self) -> None:
        await self._terminate_process()

    def get_session_id(self) -> str | None:
        return self._session_id

    def manages_history(self) -> bool:
        # Process-local transcript is read by codex_session_history.
        return True

    # ── Internals ─────────────────────────────────────────────────────────────

    def _build_spawn(
        self,
        context: AgenticContext,
    ) -> tuple[list[str] | None, dict[str, str]]:
        if not shutil.which("codex"):
            return None, {}

        opts = CodexCliOptions(
            workdir=context.workdir,
            env_vars=dict(context.env_vars) if context.env_vars else None,
            model=context.model,
            permission_mode=context.permission_mode,
            session_id=context.resume_session_id,
            resume=bool(context.resume_session_id),
            json_stream=True,
            ephemeral=True,
        )
        argv, env_from_opts = opts.to_spawn_args()

        # Inherit os.environ so codex can find creds, PATH, ~/.codex, then
        # overlay caller-provided env_vars last so they win.
        env = dict(os.environ)
        env.update(env_from_opts)
        return argv, env

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
        if proc is None or proc.returncode is not None:
            return
        try:
            proc.terminate()
        except ProcessLookupError:
            return
        try:
            await asyncio.wait_for(proc.wait(), timeout=CANCEL_GRACE_SECONDS)
        except asyncio.TimeoutError:
            logger.warning("CodexCLIStreamWorker: grace expired, sending SIGKILL")
            try:
                proc.kill()
            except ProcessLookupError:
                return
            try:
                await proc.wait()
            except Exception:
                pass


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
