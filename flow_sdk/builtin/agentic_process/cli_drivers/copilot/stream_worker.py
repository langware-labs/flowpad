"""CopilotCLIStreamWorker — non-interactive GitHub Copilot CLI JSON streaming."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Any, AsyncIterator

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    AgenticContext,
    AgenticWorker,
    worker_path_env,
)
from flow_sdk.builtin.agentic_process.cli_drivers.copilot.cli import CopilotCliOptions
from flow_sdk.builtin.agentic_process.cli_drivers.copilot.event_to_flowdata import (
    CopilotEventConverter,
    final_end_frame,
)
from flow_sdk.builtin.agentic_process.cli_drivers.copilot.session_history import (
    copilot_transcript_path_for_process,
)
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData

logger = logging.getLogger(__name__)

CANCEL_GRACE_SECONDS = 5.0


class CopilotCLIStreamWorker(AgenticWorker):
    """Runs one Copilot CLI turn and streams stdout JSONL as FlowData."""

    def __init__(self, transcript_path: Path | str | None = None) -> None:
        self._session_id: str | None = None
        self._proc: asyncio.subprocess.Process | None = None
        self._transcript_path = Path(transcript_path) if transcript_path else None
        self._interrupted = False
        self._stderr_lines: list[str] = []
        self._saw_terminal = False
        self._converter = CopilotEventConverter()

    @classmethod
    def for_process(cls, process_id: str) -> "CopilotCLIStreamWorker":
        return cls(transcript_path=copilot_transcript_path_for_process(process_id))

    @property
    def transcript_path(self) -> Path | None:
        return self._transcript_path

    async def execute(
        self,
        prompt: str,
        context: AgenticContext,
    ) -> AsyncIterator[FlowData]:
        self._session_id = context.resume_session_id or context.session_id
        argv, env = self._build_spawn(context)
        if argv is None:
            event = {
                "type": "flowpad.error",
                "sessionId": self._session_id,
                "message": "copilot binary not found in PATH",
            }
            self._write_jsonl_path(event)
            for fd in self._converter.convert_event(event):
                yield fd
            return

        logger.info("CopilotCLIStreamWorker: launching %s", " ".join(argv))
        tee_fh = None
        if self._transcript_path is not None:
            try:
                self._transcript_path.parent.mkdir(parents=True, exist_ok=True)
                tee_fh = open(self._transcript_path, "ab", buffering=0)
            except OSError as exc:
                logger.warning("CopilotCLIStreamWorker: transcript open failed %s: %s",
                               self._transcript_path, exc)

        try:
            self._proc = await asyncio.create_subprocess_exec(
                *argv,
                cwd=context.workdir,
                env=env,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except Exception as exc:
            logger.exception("CopilotCLIStreamWorker: spawn failed")
            event = {
                "type": "flowpad.error",
                "sessionId": self._session_id,
                "message": f"spawn failed: {exc}",
            }
            self._write_jsonl(tee_fh, event)
            if tee_fh:
                tee_fh.close()
            for fd in self._converter.convert_event(event):
                yield fd
            return

        try:
            assert self._proc.stdin is not None
            stdin_prompt = prompt if prompt.endswith("\n") else f"{prompt}\n"
            self._proc.stdin.write(stdin_prompt.encode("utf-8"))
            await self._proc.stdin.drain()
            self._proc.stdin.close()
        except Exception as exc:
            logger.warning("CopilotCLIStreamWorker: stdin write failed: %s", exc)

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
                sid = _maybe_extract_session_id(decoded)
                if sid:
                    self._session_id = sid
                if _is_terminal_json(decoded):
                    self._saw_terminal = True
                for fd in self._converter.convert_line(decoded):
                    yield fd
        except asyncio.CancelledError:
            self._interrupted = True
            await self._terminate_process()
            raise
        finally:
            if self._proc and self._proc.returncode is None:
                try:
                    await asyncio.wait_for(self._proc.wait(), timeout=CANCEL_GRACE_SECONDS)
                except asyncio.TimeoutError:
                    logger.warning("CopilotCLIStreamWorker: grace expired, sending SIGKILL")
                    self._proc.kill()
                    await self._proc.wait()

            try:
                await stderr_task
            except asyncio.CancelledError:
                pass

            if not self._saw_terminal:
                synthetic = self._terminal_synthetic_event()
                if synthetic is not None:
                    self._write_jsonl(tee_fh, synthetic)
                    self._saw_terminal = True
                    for fd in self._converter.convert_event(synthetic):
                        yield fd

            if tee_fh is not None:
                try:
                    tee_fh.close()
                except Exception:
                    pass

            if not self._saw_terminal:
                yield final_end_frame()

    async def close_session(self) -> None:
        self._interrupted = True
        await self._terminate_process()

    def get_session_id(self) -> str | None:
        return self._session_id

    def manages_history(self) -> bool:
        return True

    def _build_spawn(
        self,
        context: AgenticContext,
    ) -> tuple[list[str] | None, dict[str, str]]:
        # Discovered harness capability supplies the CLI's bin folder
        # (terminal-PATH resolution) — None ⇔ copilot is not installed.
        path_env = worker_path_env("copilot")
        if path_env is None:
            return None, {}

        opts = CopilotCliOptions(
            workdir=context.workdir,
            env_vars=dict(context.env_vars) if context.env_vars else None,
            model=context.model,
            permission_mode=context.permission_mode,
            effort=context.effort,
            add_dirs=list(context.add_dirs or []),
            session_id=context.resume_session_id or context.session_id,
            resume=bool(context.resume_session_id),
            json_stream=True,
            no_ask_user=True,
            allow_all=True,
        )
        argv, env_from_opts = opts.to_spawn_args()
        env = dict(os.environ)
        env.update(path_env)  # capability bin-folder PATH prepend
        env.update(env_from_opts)
        return argv, env

    async def _drain_stderr(self, proc: asyncio.subprocess.Process) -> None:
        if proc.stderr is None:
            return
        try:
            async for raw_line in proc.stderr:
                decoded = raw_line.decode("utf-8", errors="replace").rstrip()
                if decoded:
                    self._stderr_lines.append(decoded)
                    logger.debug("copilot stderr: %s", decoded)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug("Copilot stderr drain failed", exc_info=True)

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
            logger.warning("CopilotCLIStreamWorker: grace expired, sending SIGKILL")
            try:
                proc.kill()
            except ProcessLookupError:
                return
            try:
                await proc.wait()
            except Exception:
                pass

    def _terminal_synthetic_event(self) -> dict[str, Any] | None:
        if self._interrupted:
            return {
                "type": "flowpad.interrupted",
                "sessionId": self._session_id,
                "message": "copilot turn interrupted",
            }
        if self._proc and self._proc.returncode not in (0, None):
            stderr = "\n".join(self._stderr_lines).strip()
            return {
                "type": "flowpad.error",
                "sessionId": self._session_id,
                "exitCode": self._proc.returncode,
                "message": stderr or f"copilot exited with code {self._proc.returncode}",
                "stderr": stderr,
            }
        return None

    @staticmethod
    def _write_jsonl(handle, event: dict[str, Any]) -> None:
        if handle is None:
            return
        try:
            handle.write((json.dumps(event, separators=(",", ":")) + "\n").encode("utf-8"))
        except OSError:
            pass

    def _write_jsonl_path(self, event: dict[str, Any]) -> None:
        if self._transcript_path is None:
            return
        try:
            self._transcript_path.parent.mkdir(parents=True, exist_ok=True)
            with self._transcript_path.open("ab") as handle:
                self._write_jsonl(handle, event)
        except OSError:
            pass


def _maybe_extract_session_id(raw_line: str) -> str | None:
    try:
        event = json.loads(raw_line)
    except json.JSONDecodeError:
        return None
    if not isinstance(event, dict):
        return None
    sid = event.get("sessionId")
    if isinstance(sid, str) and sid:
        return sid
    result = event.get("result") if isinstance(event.get("result"), dict) else {}
    sid = result.get("sessionId")
    if isinstance(sid, str) and sid:
        return sid
    data = event.get("data") if isinstance(event.get("data"), dict) else {}
    sid = data.get("sessionId")
    if isinstance(sid, str) and sid:
        return sid
    return None


def _is_terminal_json(raw_line: str) -> bool:
    try:
        event = json.loads(raw_line)
    except json.JSONDecodeError:
        return False
    if not isinstance(event, dict):
        return False
    return event.get("type") in {"result", "flowpad.interrupted", "flowpad.error"}
