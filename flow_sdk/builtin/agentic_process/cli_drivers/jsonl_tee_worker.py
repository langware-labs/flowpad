"""``JsonlTeeStreamWorker`` — the one non-interactive JSONL turn loop shared by
the vendors whose CLI prints one JSON event per stdout line and records no
turn terminal of its own (copilot, opencode).

The loop is vendor-agnostic: spawn, tee every stdout line verbatim into the
process transcript, parse each line ONCE, learn the session id, notice the
terminal, convert to FlowData through the vendor's converter, and hold the
answer behind the shared :class:`TranscriptDurabilityGate` until the process
has settled. On a kill (no vendor terminal) it writes a synthetic
``flowpad.interrupted`` / ``flowpad.error`` event so replay and ``tail_status``
still see the turn end.

A vendor supplies only its facts: the session-id key spelling
(``sessionId`` vs ``sessionID`` — load-bearing, it rides every synthetic
event), where that id may sit in an event, which events are terminal, whether
the prompt goes down stdin or rides argv, and the converter/gate classes.
Claude and codex are structurally different (own terminal handling, SIGINT
cancel, no durability gate) and stay on their own workers.
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any, AsyncIterator, ClassVar

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    STREAM_JSON_LINE_LIMIT_BYTES,
    AgenticContext,
    AgenticWorker,
    WorkerSpawnError,
    stamp_cli_run_id,
    terminate_asyncio_process_tree,
    wait_for_asyncio_process_or_kill_tree,
)
from flow_sdk.builtin.agentic_process.cli_drivers.transcript_durability_gate import (
    TranscriptDurabilityGate,
    stream_event,
)
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData

logger = logging.getLogger(__name__)


class JsonlTeeStreamWorker(AgenticWorker):
    #: The vendor key — log prefix, ``WorkerSpawnError`` tag, synthetic-event text.
    vendor: ClassVar[str]
    #: How the vendor spells the session id in its events.
    session_key: ClassVar[str]
    #: Sub-dicts of an event that may also carry ``session_key`` (checked after the event itself).
    session_id_parents: ClassVar[tuple[str, ...]] = ()
    #: Event types that end the turn outright (the vendor's own + the synthetic ones).
    terminal_types: ClassVar[frozenset[str]]
    #: True: the prompt is written to a stdin PIPE (with a trailing newline);
    #: False: it rides argv and stdin is /dev/null.
    prompt_on_stdin: ClassVar[bool]
    converter_cls: ClassVar[type]
    gate_cls: ClassVar[type[TranscriptDurabilityGate]]

    def __init__(self, transcript_path: Path | str | None = None, process_id: str | None = None) -> None:
        self._session_id: str | None = None
        self._proc: asyncio.subprocess.Process | None = None
        self._process_run_id: str | None = None
        self._transcript_path = Path(transcript_path) if transcript_path else None
        self._process_id = process_id
        self._interrupted = False
        self._stderr_lines: list[str] = []
        self._saw_terminal = False
        self._converter = self.converter_cls()

    # ── vendor hooks ──────────────────────────────────────────────────────
    @property
    def cancel_grace_seconds(self) -> float:
        """The vendor module's ``CANCEL_GRACE_SECONDS`` — a per-module constant
        (how long THAT CLI needs to wind down) that a test can pin per vendor."""
        return 5.0

    def _end_frame(self) -> FlowData:
        """The vendor's END frame, yielded when the stream closed without any terminal."""
        raise NotImplementedError

    def _build_spawn(self, context: AgenticContext, prompt: str) -> tuple[list[str], dict[str, str], str | None]:
        """``(argv, env, stdin)``; raises :class:`WorkerSpawnError` when the CLI
        is not installed or its executable can't be resolved on the spawn PATH."""
        raise NotImplementedError

    def _pre_spawn_events(self, prompt: str) -> list[dict[str, Any]]:
        """Events to record in the transcript BEFORE the spawn (a vendor whose
        stdout never echoes the user's own prompt records it here)."""
        return []

    def _is_terminal_json(self, event: dict) -> bool:
        return event.get("type") in self.terminal_types

    def _terminal_synthetic_event(self) -> dict[str, Any] | None:
        """The turn end the vendor did not print: interrupted, or a non-zero exit."""
        if self._interrupted:
            return {
                "type": "flowpad.interrupted",
                self.session_key: self._session_id,
                "message": f"{self.vendor} turn interrupted",
            }
        if self._proc and self._proc.returncode not in (0, None):
            stderr = "\n".join(self._stderr_lines).strip()
            return {
                "type": "flowpad.error",
                self.session_key: self._session_id,
                "exitCode": self._proc.returncode,
                "message": stderr or f"{self.vendor} exited with code {self._proc.returncode}",
                "stderr": stderr,
            }
        return None

    # ── AgenticWorker surface ─────────────────────────────────────────────
    @property
    def transcript_path(self) -> Path | None:
        return self._transcript_path

    @property
    def cancelled_gracefully(self) -> bool:
        """True once this turn was interrupted — the worker self-records the abort.

        The CLI emits no terminal on kill, so ``execute`` writes a synthetic
        ``flowpad.interrupted`` event into its OWN transcript (rendered as a
        turn-terminated STATUS on replay). The cancel choke point therefore skips
        the flowpad sidecar marker — otherwise the sidecar marker AND the
        synthetic event both replay as duplicate turn-terminated STATUS frames
        (``merge_abort_markers`` has no dedup). Symmetric to claude/codex, whose
        CLIs record their own aborts on a graceful interrupt.
        """
        return self._interrupted

    async def close_session(self) -> None:
        self._interrupted = True
        await self._terminate_process()

    def get_session_id(self) -> str | None:
        return self._session_id

    def manages_history(self) -> bool:
        return True

    async def execute(self, prompt: str, context: AgenticContext) -> AsyncIterator[FlowData]:
        name = type(self).__name__
        self._process_run_id = None
        self._session_id = context.resume_session_id or context.session_id
        try:
            argv, env, stdin = self._build_spawn(context, prompt)
        except WorkerSpawnError as e:
            # Surface the message on the transcript (tail_status → FAILED) and
            # the chat stream, then propagate so the turn runner latches
            # status=FAILED + start_failure.
            event = {"type": "flowpad.error", self.session_key: self._session_id, "message": str(e)}
            self._write_jsonl_path(event)
            for fd in self._converter.convert_event(event):
                yield fd
            raise

        logger.info("%s: launching %s", name, " ".join(argv))
        self._process_run_id = stamp_cli_run_id(env)
        tee_fh = None
        if self._transcript_path is not None:
            try:
                self._transcript_path.parent.mkdir(parents=True, exist_ok=True)
                tee_fh = open(self._transcript_path, "ab", buffering=0)
            except OSError as exc:
                logger.warning("%s: transcript open failed %s: %s", name, self._transcript_path, exc)

        for event in self._pre_spawn_events(prompt):
            self._write_jsonl(tee_fh, event)

        try:
            self._proc = await asyncio.create_subprocess_exec(
                *argv,
                cwd=context.workdir,
                env=env,
                stdin=asyncio.subprocess.PIPE if self.prompt_on_stdin else asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                limit=STREAM_JSON_LINE_LIMIT_BYTES,
            )
        except Exception as exc:
            logger.exception("%s: spawn failed", name)
            event = {"type": "flowpad.error", self.session_key: self._session_id, "message": f"spawn failed: {exc}"}
            self._write_jsonl(tee_fh, event)
            if tee_fh:
                tee_fh.close()
            for fd in self._converter.convert_event(event):
                yield fd
            raise WorkerSpawnError(self.vendor, str(event["message"])) from exc

        if self.prompt_on_stdin:
            try:
                assert self._proc.stdin is not None
                # stdin already carries any system-prompt addition (prepended by
                # the options' sink); the CLI just needs a trailing newline to submit.
                base = stdin or ""
                self._proc.stdin.write((base if base.endswith("\n") else f"{base}\n").encode("utf-8"))
                await self._proc.stdin.drain()
                self._proc.stdin.close()
            except Exception as exc:
                logger.warning("%s: stdin write failed: %s", name, exc)

        stderr_task = asyncio.create_task(self._drain_stderr(self._proc))
        durability_gate = self.gate_cls()
        cancelled = False

        try:
            assert self._proc.stdout is not None
            async for raw_line in self._proc.stdout:
                if tee_fh is not None:
                    try:
                        tee_fh.write(raw_line)
                    except OSError:
                        pass
                # Parse the line ONCE — session id, terminal detection, the
                # converter, and the durability gate all read the same event.
                event = stream_event(raw_line.decode("utf-8", errors="replace"))
                frames: list[FlowData] = []
                if event is not None:
                    sid = self._session_id_of(event)
                    if sid:
                        self._session_id = sid
                    if self._is_terminal_json(event):
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
                    self._proc, self.cancel_grace_seconds, run_id=self._process_run_id
                )
            try:
                await stderr_task
            except asyncio.CancelledError:
                pass

            # The process has settled, so its session file cannot trail stdout
            # any further. Release the held answer + result/end in their
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
                yield self._end_frame()

    # ── shared plumbing ───────────────────────────────────────────────────
    def _session_id_of(self, event: dict) -> str | None:
        for holder in (event, *(event.get(k) for k in self.session_id_parents)):
            if isinstance(holder, dict):
                sid = holder.get(self.session_key)
                if isinstance(sid, str) and sid:
                    return sid
        return None

    async def _drain_stderr(self, proc: asyncio.subprocess.Process) -> None:
        if proc.stderr is None:
            return
        try:
            async for raw_line in proc.stderr:
                decoded = raw_line.decode("utf-8", errors="replace").rstrip()
                if decoded:
                    self._stderr_lines.append(decoded)
                    logger.debug("%s stderr: %s", self.vendor, decoded)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug("%s stderr drain failed", self.vendor, exc_info=True)

    async def _terminate_process(self) -> None:
        proc = self._proc
        if proc is None:
            return
        await terminate_asyncio_process_tree(proc, self.cancel_grace_seconds, run_id=self._process_run_id)

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
