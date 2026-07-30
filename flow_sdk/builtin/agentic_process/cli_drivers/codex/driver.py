"""OpenAI Codex WorkerDriver — vendor glue for the AgenticProcess driver layer.

Concentrates everything previously expressed as ``if worker_type == CODEX`` in
``AgenticProcess`` so the entity stays vendor-pure: cli_options building,
headless ``codex exec --json`` turn execution, transcript location (process-
local file the worker tee'd), tail-status mapping, history loading, and the
prompt-composition compatibility hook.
"""

from __future__ import annotations

import asyncio
import logging
import re
from pathlib import Path
from typing import TYPE_CHECKING

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    AgenticContext,
    DeviceLoginSpec,
    AgenticProcessContextKey,
    WorkerAuthResult,
    AgentOptions,
    WorkerSpawnError,
    apply_worker_env,
    apply_worker_secret_env,
    latch_spawn_failure,
    restart_payload_from_cli_options,
    run_worker_auth_probe,
)
from flow_sdk.builtin.agentic_process.cli_drivers.codex.cli import CodexAgentOptions
from flow_sdk.builtin.agentic_process.cli_drivers.codex.session_history import (
    codex_transcript_path_for_process,
    find_codex_session_jsonl,
    find_latest_codex_session_jsonl,
    read_codex_rollout_meta,
)
from flow_sdk.builtin.agentic_process.cli_drivers.codex.session_history import (
    load_session_history as _codex_load_session_history,
)
from flow_sdk.builtin.agentic_process.cli_drivers.codex.session_history import (
    load_transcript_history as _codex_load_transcript_history,
)
from flow_sdk.builtin.agentic_process.cli_drivers.codex.status import codex_tail_status
from flow_sdk.builtin.agentic_process.cli_drivers.codex.stream_worker import (
    CodexCLIStreamWorker,
)
from flow_sdk.builtin.worker_status import WorkerStatus
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse
from flow_sdk.transcript_analyzer import (
    TranscriptDescriptor,
    TranscriptFormat,
    TranscriptSource,
)

if TYPE_CHECKING:
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData
    from flow_sdk.responses.response import ApiResponse

logger = logging.getLogger(__name__)


class CodexDriver:
    """Vendor glue for OpenAI Codex. Implements the ``WorkerDriver`` Protocol."""

    name = WorkerType.CODEX.value
    # Codex's TUI needs a discrete Enter after the paste settles, not a
    # trailing \r in the pasted text (Shell.write_then_submit).
    pty_submits_on_paste = False
    # Composer-ready marker (QA C09b). Empirically grounded on codex-cli
    # 0.144.1 raw PTY captures (tests/unit/fixtures/codex_pty_*.bin): the
    # ``>_ OpenAI Codex (vX.Y.Z)`` banner paints in the same frame as the
    # composer input line, and never renders while the directory-trust
    # interstitial is up (that screen has no banner — and paints its own ``›``
    # cursor, so a prompt-glyph marker would false-positive). The banner text
    # is painted contiguously, so it survives ``strip_pty_controls``.
    pty_composer_ready_pattern = re.compile(r">_ OpenAI Codex")
    pins_resume_cwd = False  # codex mints its own rollout; no transcript-cwd pinning, no fork

    # ── CLI shape ────────────────────────────────────────────────────────────

    def cli_options(self, process: "AgenticProcess") -> CodexAgentOptions:
        """Build a Codex CLI command for ``process``.

        Codex doesn't accept inline ``--agents`` like Claude. We surface the
        embedded agent names as ``skill_names`` so ``cmd_line`` reflects them
        (some tests assert on this); the instruction bodies are delivered via
        generated process instruction assets.
        """
        cmd = CodexAgentOptions.from_json(process.cli_config)
        cmd.session_id = process.session_id
        cmd.workdir = process.workdir
        cmd.add_dirs = process.resolved_add_dirs
        agents_json = process.get_agents_json()
        if agents_json:
            cmd.skill_names = list(agents_json.keys())
        # ``pty_mode=True`` means an interactive PTY transport — codex's
        # interactive TUI is the bare ``codex`` invocation, NOT ``codex exec
        # --json``. Toggle ``json_stream`` so ``to_spawn_args`` emits the right
        # argv. Headless print-mode turns flip back through ``CodexCLIStreamWorker``
        # which always uses the json-stream shape. (Keys on the transport intent,
        # not ``visible`` — tab visibility never changes the worker argv.)
        if process.pty_mode:
            cmd.json_stream = False
            cmd.ephemeral = False
        return cmd

    def restart_snapshot(
        self,
        process: "AgenticProcess",
        options: AgentOptions,
    ) -> dict:
        return restart_payload_from_cli_options(options)

    # ── Per-turn execution ───────────────────────────────────────────────────

    async def headless_prompt(
        self,
        process: "AgenticProcess",
        instruction: str,
    ) -> "ApiResponse":
        """Headless ``codex exec --json`` execution.

        No Shell entity, no PTY: codex events stream from a child process
        whose stdout is tee'd into ``<process_record_dir>/codex_transcript.jsonl``.
        ``stream_transcript()`` and ``tail_status()`` operate on that file.
        """
        try:
            await process.get_project()
        except Exception:
            logger.debug("CodexDriver.headless_prompt: get_project failed", exc_info=True)
        instruction_assets = await process.prepare_system_instruction_assets()
        if not process.workdir:
            return ApiFailResponse(message="codex prompt: workdir is not set")

        full_prompt = self.compose_prompt(instruction, process.get_agents_json())

        cli_cfg = process.cli_config or {}
        env_vars = apply_worker_env(dict(cli_cfg.get("env_vars") or {}), process)
        await apply_worker_secret_env(env_vars, process)
        context = AgenticContext(
            workdir=process.workdir,
            env_vars=env_vars,
            model=cli_cfg.get("model"),
            permission_mode=cli_cfg.get("permission_mode", "bypassPermissions"),
            # Resume ONLY when codex actually has a rollout for this id. Codex
            # (unlike claude) mints its own rollout id — a preassigned/PTY
            # ``session_id`` that codex never wrote (e.g. a fresh chat tab, or a
            # PTY session killed before its first turn) has no rollout, and
            # ``codex exec resume <unknown-id>`` exits with an error. Starting
            # fresh lets the worker mint a rollout; its real id is captured from
            # the stream below and persisted back onto ``process.session_id``.
            resume_session_id=process.session_id if self.has_resumable_session(process) else None,
            add_dirs=list(process.resolved_add_dirs or []),
            **process._instruction_context_kwargs(instruction_assets),
        )

        worker = CodexCLIStreamWorker.for_process(process.id)
        from flow_sdk.builtin.agentic_process.agentic_process import (
            register_prompt_worker,
            unregister_prompt_worker,
        )

        register_prompt_worker(process.id, worker)
        # Setup between registration and task scheduling can raise. The caller's
        # admission ``finally`` can no longer clean the slot — register_prompt_worker
        # popped the admission and moved ownership to ``_PROMPT_WORKERS``. Until
        # _run_turn is scheduled (its ``finally`` owns unregister), THIS frame owns
        # the worker slot: a raise here would leak it → prompt_worker_active pinned
        # True forever (permanent 409 + busy). Hand ownership off on success.
        try:
            # Touch the transcript file so ``tail_status`` returns INITIALIZING
            # (rather than None) before the worker writes its first event. Mirrors
            # the Claude path's eager session_id assignment.
            try:
                transcript_path = worker.transcript_path
                if transcript_path is not None and not transcript_path.exists():
                    transcript_path.parent.mkdir(parents=True, exist_ok=True)
                    transcript_path.touch()
            except OSError:
                logger.debug("CodexDriver.headless_prompt: failed to pre-touch transcript", exc_info=True)

            from flow_sdk.builtin.process_lifecycle import ProcessStatus

            if process.status != ProcessStatus.RUNNING.value:
                process.status = ProcessStatus.RUNNING.value
                try:
                    await process.save()
                except Exception:
                    logger.debug("CodexDriver.headless_prompt: lifecycle save failed", exc_info=True)

            process_ref = process
            process_id = process.id

            # Multi-turn correctness: see ClaudeDriver.headless_prompt + the
            # AgenticProcess._discover_status_from_transcript override.
            object.__setattr__(process_ref, "_turn_in_flight", True)
            try:
                await process_ref.notify_updated()
            except Exception:
                logger.exception("CodexDriver.headless_prompt: start-of-turn notify_updated failed")

            # Session adoption (and its restart-snapshot bookkeeping) is owned by
            # AgenticProcess.adopt_worker_session; the turn-scoped adopter trusts
            # only the turn-initial report (spurious-rotation guard).
            adopt_session = process_ref.make_turn_session_adopter("CodexDriver.headless_prompt")

            async def _run_turn() -> None:
                try:
                    async for fd in worker.execute(prompt=full_prompt, context=context):
                        await adopt_session(worker.get_session_id())
                        try:
                            await process_ref.emit_flow_data(fd.model_dump())
                        except Exception:
                            logger.debug("CodexDriver.headless_prompt: emit_flow_data failed", exc_info=True)
                except WorkerSpawnError as e:
                    # No subprocess ever started — end the process FAILED with the
                    # start_failure latch (the ERROR frame was already emitted).
                    await latch_spawn_failure(process_ref, e)
                except Exception:
                    logger.exception("CodexDriver.headless_prompt: worker error")
                finally:
                    unregister_prompt_worker(process_id, worker)
                    # Terminal status broadcast + completion-driven queue advance
                    # (see AgenticProcess.end_headless_turn).
                    await process_ref.end_headless_turn("CodexDriver.headless_prompt")

            asyncio.create_task(_run_turn(), name=f"codex-{process.id[:8]}")
        except BaseException:
            # _run_turn never took ownership of the slot — release it here so the
            # next turn is not permanently rejected with a 409.
            unregister_prompt_worker(process.id, worker)
            raise
        return ApiSuccessResponse(data={"status": "started", "worker": self.name})

    def stream_worker(self, process: "AgenticProcess") -> CodexCLIStreamWorker:
        return CodexCLIStreamWorker.for_process(process.id)

    # ── Auth ─────────────────────────────────────────────────────────────────

    async def auth_probe(self) -> WorkerAuthResult:
        """`codex login status` against the discovered CLI (exit-code based)."""
        return await run_worker_auth_probe(self.name)

    # RFC-8628 device flow. Requires "Allow device code login" enabled on the
    # user's ChatGPT account; the CLI errors clearly when it isn't.
    device_login_spec = DeviceLoginSpec(
        login_argv=("codex", "login", "--device-auth"),
        url_re=re.compile(r"(https://auth\.openai\.com/\S+)"),
        code_re=re.compile(r"^\s*([A-Z0-9]{2,10}-[A-Z0-9]{2,10})\s*$", re.MULTILINE),
        accepts_code_paste=False,
    )

    # ── Transcript discovery ─────────────────────────────────────────────────

    def transcript_descriptor(self, process: "AgenticProcess") -> TranscriptDescriptor | None:
        """Resolve the Codex transcript for READING (history / prompts / status).

        Transcript↔output alignment: the rollout (``~/.codex/sessions/...``) is the
        canonical, complete record — user-message entries AND assistant output, all
        turns, one resumed session. The process-local file is only the tee'd
        ``codex exec --json`` *stdout* — assistant output with NO user-message entry
        (the headless prompt is an argv, not a stream event), so ``transcript/prompts``
        came back empty for headless. Prefer the rollout for BOTH transports (visible
        already did); fall back to the stdout tee only before codex mints/captures
        its rollout id. (Live streaming reads the worker stdout directly, not this.)
        """
        rollout = self._rollout_descriptor(process)
        if rollout is not None:
            return rollout
        return self._process_local_descriptor(process)

    def transcript_path(self, process: "AgenticProcess") -> Path | None:
        descriptor = self.transcript_descriptor(process)
        return descriptor.path if descriptor else None

    def skills_root(self, process: "AgenticProcess", assets_dir: Path) -> Path:
        """Codex discovers skills only from ``$CODEX_HOME/skills`` (a global,
        non-per-process location), not from a mounted ``--add-dir``."""
        from flow_sdk.instance_settings import get_instance_settings

        return get_instance_settings().codex_home / "skills"

    def _process_local_descriptor(self, process: "AgenticProcess") -> TranscriptDescriptor | None:
        """Process-local JSONL the headless codex worker tee'd."""
        path = codex_transcript_path_for_process(process.id)
        if not path.exists():
            return None
        return TranscriptDescriptor(
            path=path,
            format=TranscriptFormat.CODEX_STREAM,
            source=TranscriptSource.PROCESS_LOCAL,
            session_id=process.session_id or "",
        )

    def _rollout_descriptor(self, process: "AgenticProcess") -> TranscriptDescriptor | None:
        path: Path | None = None
        if process.session_id:
            path = find_codex_session_jsonl(process.session_id)
        if path is None:
            path = find_latest_codex_session_jsonl(
                cwd=process.workdir,
                started_at=self._worker_started_at(process),
            )
        if path is None or not path.exists():
            return None
        meta = read_codex_rollout_meta(path)
        session_id = str(meta.get("id") or process.session_id or "")
        return TranscriptDescriptor(
            path=path,
            format=TranscriptFormat.CODEX_ROLLOUT,
            source=TranscriptSource.WORKER_SESSION,
            session_id=session_id,
        )

    def _worker_started_at(self, process: "AgenticProcess") -> str | None:
        context = process.context_data or {}
        value = context.get(AgenticProcessContextKey.WORKER_STARTED_AT.value)
        return str(value) if value else None

    def tail_status(self, transcript_path: Path) -> WorkerStatus:
        return codex_tail_status(transcript_path)

    def has_resumable_session(self, process: "AgenticProcess") -> bool:
        return bool(process.session_id) and find_codex_session_jsonl(process.session_id) is not None

    def supports_plan_mode(self, process: "AgenticProcess") -> bool:
        # Codex has no CLI plan-mode equivalent yet; tracked as a follow-up.
        return False

    # ── History materialisation ──────────────────────────────────────────────

    def load_history(self, process: "AgenticProcess") -> list["FlowData"]:
        descriptor = self.transcript_descriptor(process)
        if descriptor is not None:
            return _codex_load_transcript_history(descriptor.path)
        return _codex_load_session_history(process.session_id or "", process_id=process.id)

    # ── Prompt composition ───────────────────────────────────────────────────

    def compose_prompt(
        self,
        instruction: str,
        agents_json: dict | None,
    ) -> str:
        return instruction

    # ── External-session probe ───────────────────────────────────────────────

    def external_session_dirs(self) -> set[str]:
        """Snapshot of ``~/.codex/sessions/`` rollout file names.

        ``--ephemeral`` should keep this set empty between turns, mirroring
        the Claude driver's ``flow-records-agentic`` invariant.
        """
        from flow_sdk.instance_settings import get_instance_settings

        sessions_root = get_instance_settings().codex_sessions_dir
        if not sessions_root.is_dir():
            return set()
        return {p.name for p in sessions_root.rglob("rollout-*.jsonl")}
