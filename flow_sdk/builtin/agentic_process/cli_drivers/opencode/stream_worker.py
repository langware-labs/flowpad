"""OpenCodeCLIStreamWorker — non-interactive OpenCode CLI JSON streaming."""

from __future__ import annotations

import asyncio
import json
import logging
import time
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
from flow_sdk.builtin.agentic_process.cli_drivers.opencode.cli import OpenCodeAgentOptions
from flow_sdk.builtin.agentic_process.cli_drivers.opencode.event_to_flowdata import (
    OpenCodeEventConverter,
    final_end_frame,
)
from flow_sdk.builtin.agentic_process.cli_drivers.opencode.session_history import (
    opencode_transcript_path_for_process,
)
from flow_sdk.builtin.agentic_process.cli_drivers.transcript_durability_gate import (
    TranscriptDurabilityGate,
    stream_event,
)
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData

logger = logging.getLogger(__name__)

CANCEL_GRACE_SECONDS = 5.0

# Events that prove the turn is CONTINUING past a held terminal candidate.
_CONTINUATION_EVENTS = frozenset({"step_start", "text", "reasoning", "tool_use"})


class _TranscriptDurabilityGate(TranscriptDurabilityGate):
    """The shared ordering gate, told what OpenCode's two vendor facts are.

    OpenCode's terminal is ``step_finish`` with ``part.reason == "stop"``; the
    same event with ``reason == "tool-calls"`` means the tool loop continues and
    another step follows, so it is emphatically *not* terminal.
    """

    def is_terminal_candidate(self, event: dict, frames: list[FlowData]) -> bool:
        if event.get("type") != "step_finish":
            return False
        part = event.get("part") if isinstance(event.get("part"), dict) else {}
        return part.get("reason") == "stop"

    def is_continuation(self, event_type: str) -> bool:
        return event_type in _CONTINUATION_EVENTS


class OpenCodeCLIStreamWorker(AgenticWorker):
    """Runs one OpenCode CLI turn and streams stdout JSONL as FlowData."""

    def __init__(
        self,
        transcript_path: Path | str | None = None,
        process_id: str | None = None,
    ) -> None:
        self._session_id: str | None = None
        self._proc: asyncio.subprocess.Process | None = None
        self._process_run_id: str | None = None
        self._transcript_path = Path(transcript_path) if transcript_path else None
        # Needed to generate the per-process config when the caller hands over
        # the raw assets dir rather than a config file — see
        # ``_config_path_from_context``.
        self._process_id = process_id
        self._interrupted = False
        self._stderr_lines: list[str] = []
        self._saw_terminal = False
        self._resolved_model: str | None = None
        self._converter = OpenCodeEventConverter()

    @classmethod
    def for_process(cls, process_id: str) -> "OpenCodeCLIStreamWorker":
        return cls(
            transcript_path=opencode_transcript_path_for_process(process_id),
            process_id=process_id,
        )

    @property
    def transcript_path(self) -> Path | None:
        return self._transcript_path

    @property
    def cancelled_gracefully(self) -> bool:
        """True once this turn was interrupted.

        ``execute`` writes a synthetic ``flowpad.interrupted`` event into its OWN
        transcript (rendered as a turn-terminated STATUS on replay), so the cancel
        choke point must skip the flowpad sidecar marker — otherwise the sidecar
        AND the synthetic event both replay as duplicate turn-terminated STATUS
        frames (``merge_abort_markers`` has no dedup). Same reasoning as copilot.
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
            argv, env, _stdin = self._build_spawn(context, prompt)
        except WorkerSpawnError as e:
            event = {
                "type": "flowpad.error",
                "sessionID": self._session_id,
                "message": str(e),
            }
            self._write_jsonl_path(event)
            for fd in self._converter.convert_event(event):
                yield fd
            raise

        logger.info("OpenCodeCLIStreamWorker: launching %s", " ".join(argv))
        self._process_run_id = stamp_cli_run_id(env)
        tee_fh = None
        if self._transcript_path is not None:
            try:
                self._transcript_path.parent.mkdir(parents=True, exist_ok=True)
                tee_fh = open(self._transcript_path, "ab", buffering=0)
            except OSError as exc:
                logger.warning(
                    "OpenCodeCLIStreamWorker: transcript open failed %s: %s",
                    self._transcript_path,
                    exc,
                )

        # OpenCode's stdout stream never carries the user's own message
        # (upstream #29997), so ``transcript/prompts`` would come back empty for
        # every headless turn. Record it ourselves, before the spawn, so the
        # transcript is complete regardless of what the CLI prints.
        self._write_jsonl(tee_fh, self._user_prompt_event(prompt))

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
        except Exception as exc:
            logger.exception("OpenCodeCLIStreamWorker: spawn failed")
            event = {
                "type": "flowpad.error",
                "sessionID": self._session_id,
                "message": f"spawn failed: {exc}",
            }
            self._write_jsonl(tee_fh, event)
            if tee_fh:
                tee_fh.close()
            for fd in self._converter.convert_event(event):
                yield fd
            raise WorkerSpawnError("opencode", str(event["message"])) from exc

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

    def _user_prompt_event(self, prompt: str) -> dict[str, Any]:
        """The user's own turn, which opencode's stdout never emits (#29997).

        It also carries the resolved model slug: no event in opencode's stream
        names a model, so this is the only place the transcript can learn which
        one produced the turn. Without it every entry parses as ``model=None``
        and the pricing layer falls back to its default table — right only when
        the configured model happens to be that default.
        """
        event: dict[str, Any] = {
            "type": "flowpad.user_prompt",
            "timestamp": int(time.time() * 1000),
            "sessionID": self._session_id,
            "part": {"type": "text", "text": prompt},
        }
        if self._resolved_model:
            event["model"] = self._resolved_model
        return event

    def _build_spawn(
        self,
        context: AgenticContext,
        prompt: str,
    ) -> tuple[list[str], dict[str, str], str | None]:
        """Build the ``(argv, env, stdin)`` spawn tuple.

        Raises :class:`WorkerSpawnError` when opencode is not installed (no
        harness capability discovered) or its executable can't be resolved on
        the spawn PATH.
        """
        # ``--session`` only CONTINUES an existing session (opencode exits 1 with
        # "Session not found" otherwise), so resume is driven purely by whether
        # the caller resolved a resumable id.
        resume_id = context.resume_session_id
        opts = OpenCodeAgentOptions(
            workdir=context.workdir,
            env_vars=dict(context.env_vars) if context.env_vars else None,
            model=context.model,
            permission_mode=context.permission_mode,
            session_id=resume_id,
            resume=bool(resume_id),
            json_stream=True,
            add_dirs=list(context.add_dirs or []),
            config_path=_config_path_from_context(context, self._process_id),
        )
        # The tier ('sm'/'md') has already been resolved to a concrete slug here;
        # stash it so the transcript can record which model produced the turn.
        self._resolved_model = opts.resolved_model
        argv, env_from_opts, stdin = opts.to_spawn(
            instruction=prompt, system_prompt_append=context.instructions
        )
        env = build_worker_spawn_env("opencode", env_from_opts)
        argv = resolve_worker_argv0("opencode", argv, env)
        return argv, env, stdin

    async def _drain_stderr(self, proc: asyncio.subprocess.Process) -> None:
        if proc.stderr is None:
            return
        try:
            async for raw_line in proc.stderr:
                decoded = raw_line.decode("utf-8", errors="replace").rstrip()
                if decoded:
                    self._stderr_lines.append(decoded)
                    logger.debug("opencode stderr: %s", decoded)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug("OpenCode stderr drain failed", exc_info=True)

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
                "sessionID": self._session_id,
                "message": "opencode turn interrupted",
            }
        if self._proc and self._proc.returncode not in (0, None):
            stderr = "\n".join(self._stderr_lines).strip()
            return {
                "type": "flowpad.error",
                "sessionID": self._session_id,
                "exitCode": self._proc.returncode,
                "message": stderr or f"opencode exited with code {self._proc.returncode}",
                "stderr": stderr,
            }
        # A clean exit that printed no terminal ``step_finish`` still ended the
        # turn (upstream #26855 reports this can happen). Close it explicitly so
        # ``tail_status`` can reach COMPLETE instead of hanging on the last
        # non-terminal line.
        if self._proc and self._proc.returncode == 0:
            return {
                "type": "flowpad.result",
                "sessionID": self._session_id,
                "exitCode": 0,
                "reason": "synthetic-terminal",
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


def _config_path_from_context(context: AgenticContext, process_id: str | None = None) -> str | None:
    """Resolve ``OPENCODE_CONFIG`` — always a FILE, never a directory.

    OpenCode has no ``--add-dir``: instruction assets and skills reach the
    worker only through this file, handed over as ``custom_instruction_dirs[0]``
    (the same context field copilot uses for its own instruction sink).

    That field carries TWO different shapes depending on which prompt path
    built the context, and they must both land on a config file here:

    * ``OpenCodeDriver.headless_prompt`` generates the per-process
      ``opencode.json`` itself and passes THAT path — already a file.
    * The shared headless prompt path
      (``AgenticProcess._instruction_context_kwargs``) passes the raw
      instruction-assets DIRECTORY, because that is what every other vendor's
      driver wants from the field.

    Handing opencode a directory is fatal, not degraded: it reads
    ``OPENCODE_CONFIG`` eagerly and dies on the first read with
    ``BadResource: FileSystem.readFile (<dir>)``, exit 1, before any model
    call — which killed every chat turn started from the UI while a bare
    ``createProcess`` + prompt (no instruction assets, so no value in the
    field) still worked. So when we are handed the assets dir, generate the
    config from it here — through the SAME generator the driver uses, so the
    two prompt paths can never disagree about what goes in the file.
    """
    dirs = list(context.custom_instruction_dirs or [])
    if not dirs:
        return None
    candidate = Path(dirs[0])
    if candidate.is_file():
        return str(candidate)
    if not candidate.is_dir() or not process_id:
        return None

    from flow_sdk.builtin.agentic_process.cli_drivers.opencode.config_gen import (
        config_for_assets_dir,
    )

    generated = config_for_assets_dir(process_id, candidate)
    return str(generated) if generated else None


def _maybe_extract_session_id(event: dict) -> str | None:
    sid = event.get("sessionID")
    if isinstance(sid, str) and sid:
        return sid
    part = event.get("part") if isinstance(event.get("part"), dict) else {}
    sid = part.get("sessionID")
    if isinstance(sid, str) and sid:
        return sid
    return None


def _is_terminal_json(event: dict) -> bool:
    event_type = event.get("type")
    if event_type in {"flowpad.interrupted", "flowpad.error", "flowpad.result"}:
        return True
    if event_type == "step_finish":
        part = event.get("part") if isinstance(event.get("part"), dict) else {}
        return part.get("reason") == "stop"
    return False
