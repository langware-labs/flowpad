"""CopilotCLIStreamWorker — non-interactive GitHub Copilot CLI JSON streaming."""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any, AsyncIterator

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    STREAM_JSON_LINE_LIMIT_BYTES,
    AgenticContext,
    AgenticWorker,
    WorkerSpawnError,
    build_worker_spawn_env,
    resolve_worker_argv0,
    stamp_cli_run_id,
    terminate_asyncio_process_tree,
    wait_for_asyncio_process_or_kill_tree,
)
from flow_sdk.builtin.agentic_process.cli_drivers.copilot.cli import CopilotAgentOptions
from flow_sdk.builtin.agentic_process.cli_drivers.copilot.event_to_flowdata import (
    CopilotEventConverter,
    final_end_frame,
)
from flow_sdk.builtin.agentic_process.cli_drivers.copilot.session_history import (
    copilot_transcript_path_for_process,
)
from flow_sdk.builtin.agentic_process.cli_drivers.transcript_durability_gate import (
    TranscriptDurabilityGate,
    stream_event,
)
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData

logger = logging.getLogger(__name__)

CANCEL_GRACE_SECONDS = 5.0

# stdout event types that prove the turn is CONTINUING past a held terminal
# candidate (a new message, a new turn, or a tool round-trip).
_CONTINUATION_EVENTS = frozenset({"user.message", "assistant.turn_start", "assistant.message_start"})


class _TranscriptDurabilityGate(TranscriptDurabilityGate):
    """The shared ordering gate, told what Copilot's two vendor facts are.

    Copilot CLI 1.0.78 prints an ``assistant.message`` event on stdout BEFORE
    appending the matching row to the session events file it is read back
    from (``~/.copilot/session-state/<id>/events.jsonl``, resolved by
    ``CopilotDriver.transcript_descriptor``) — measured at 0.78 s of drift,
    with the file still ending at ``assistant.turn_start`` when the CHAT frame
    lands. Passive trailers (``assistant.reasoning``, ``assistant.turn_end``,
    ``session.usage_checkpoint``, ``assistant.idle``) are not continuations —
    they may legitimately follow the real answer, so they join the hold.
    """

    def is_terminal_candidate(self, event: dict, frames: list[FlowData]) -> bool:
        return event.get("type") == "assistant.message"

    def is_continuation(self, event_type: str) -> bool:
        return event_type in _CONTINUATION_EVENTS or event_type.startswith("tool.")


class CopilotCLIStreamWorker(AgenticWorker):
    """Runs one Copilot CLI turn and streams stdout JSONL as FlowData."""

    def __init__(self, transcript_path: Path | str | None = None) -> None:
        self._session_id: str | None = None
        self._proc: asyncio.subprocess.Process | None = None
        self._process_run_id: str | None = None
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

    @property
    def cancelled_gracefully(self) -> bool:
        """True once this turn was interrupted — copilot self-records the abort.

        Copilot's CLI emits no terminal on kill, so ``execute`` writes a synthetic
        ``flowpad.interrupted`` event into its OWN transcript (rendered as a
        turn-terminated STATUS on replay). The cancel choke point therefore skips
        the flowpad sidecar marker for copilot too — otherwise the sidecar marker
        AND the synthetic event both replay as duplicate turn-terminated STATUS
        frames (``merge_abort_markers`` has no dedup). Symmetric to claude/codex,
        whose CLIs record their own aborts on a graceful interrupt.
        """
        return self._interrupted

    async def execute(
        self,
        prompt: str,
        context: AgenticContext,
    ) -> AsyncIterator[FlowData]:
        self._process_run_id = None
        self._session_id = context.resume_session_id or context.session_id
        try:
            argv, env, stdin = self._build_spawn(context, prompt)
        except WorkerSpawnError as e:
            # Surface the message on the transcript (tail_status → FAILED) and
            # the chat stream, then propagate so the turn runner latches
            # status=FAILED + start_failure.
            event = {
                "type": "flowpad.error",
                "sessionId": self._session_id,
                "message": str(e),
            }
            self._write_jsonl_path(event)
            for fd in self._converter.convert_event(event):
                yield fd
            raise

        logger.info("CopilotCLIStreamWorker: launching %s", " ".join(argv))
        self._process_run_id = stamp_cli_run_id(env)
        tee_fh = None
        if self._transcript_path is not None:
            try:
                self._transcript_path.parent.mkdir(parents=True, exist_ok=True)
                tee_fh = open(self._transcript_path, "ab", buffering=0)
            except OSError as exc:
                logger.warning("CopilotCLIStreamWorker: transcript open failed %s: %s", self._transcript_path, exc)

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
            raise WorkerSpawnError("copilot", str(event["message"])) from exc

        try:
            assert self._proc.stdin is not None
            # stdin already carries any system-prompt addition (prepended by the
            # options' sink); copilot just needs a trailing newline to submit.
            base = stdin or ""
            stdin_prompt = base if base.endswith("\n") else f"{base}\n"
            self._proc.stdin.write(stdin_prompt.encode("utf-8"))
            await self._proc.stdin.drain()
            self._proc.stdin.close()
        except Exception as exc:
            logger.warning("CopilotCLIStreamWorker: stdin write failed: %s", exc)

        stderr_task = asyncio.create_task(self._drain_stderr(self._proc))
        durability_gate = _TranscriptDurabilityGate()
        cancelled = False

        try:
            assert self._proc.stdout is not None
            async for raw_line in self._proc.stdout:
                if tee_fh is not None:
                    try:
                        tee_fh.write(raw_line)
                    except OSError:
                        pass
                decoded = raw_line.decode("utf-8", errors="replace")
                # Parse the line ONCE — session id, terminal detection, the
                # converter, and the durability gate all read the same event.
                event = stream_event(decoded)
                frames: list[FlowData] = []
                if event is not None:
                    sid = _maybe_extract_session_id(event)
                    if sid:
                        self._session_id = sid
                    if _is_terminal_json(event):
                        self._saw_terminal = True
                    frames = self._converter.convert_event(event)
                for fd in durability_gate.feed(event, frames):
                    yield fd
        except asyncio.CancelledError:
            self._interrupted = True
            cancelled = True
            await self._terminate_process()
            raise
        finally:
            if self._proc:
                await wait_for_asyncio_process_or_kill_tree(
                    self._proc,
                    CANCEL_GRACE_SECONDS,
                    run_id=self._process_run_id,
                )

            try:
                await stderr_task
            except asyncio.CancelledError:
                pass

            # The process has settled, so its session events.jsonl cannot trail
            # stdout any further. Release the held answer + result/end in their
            # original order. A cancelled consumer receives no late data.
            if not cancelled:
                for fd in durability_gate.drain():
                    yield fd

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
        prompt: str,
    ) -> tuple[list[str], dict[str, str], str | None]:
        """Build the ``(argv, env, stdin)`` spawn tuple.

        Raises :class:`WorkerSpawnError` when copilot is not installed (no
        harness capability discovered) or its executable can't be resolved on
        the spawn PATH.
        """
        opts = CopilotAgentOptions(
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
            no_custom_instructions=not bool(context.custom_instruction_dirs),
            custom_instruction_dirs=list(context.custom_instruction_dirs or []),
            plugin_dirs=list(context.plugin_dirs or []),
        )
        # Asset-backed system instructions ride COPILOT_CUSTOM_INSTRUCTIONS_DIRS;
        # the legacy system_prompt_append path remains unused for new launches.
        argv, env_from_opts, stdin = opts.to_spawn(instruction=prompt, system_prompt_append=context.instructions)
        # Context env_vars win (except the discovered capability bin folder
        # stays first on PATH); argv[0] is pinned to the discovered absolute
        # executable so a stripped backend service PATH can't break the spawn.
        env = build_worker_spawn_env("copilot", env_from_opts)
        argv = resolve_worker_argv0("copilot", argv, env)
        return argv, env, stdin

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
        if proc is None:
            return
        await terminate_asyncio_process_tree(
            proc,
            CANCEL_GRACE_SECONDS,
            run_id=self._process_run_id,
        )

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


def _maybe_extract_session_id(event: dict) -> str | None:
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


def _is_terminal_json(event: dict) -> bool:
    return event.get("type") in {"result", "flowpad.interrupted", "flowpad.error"}
