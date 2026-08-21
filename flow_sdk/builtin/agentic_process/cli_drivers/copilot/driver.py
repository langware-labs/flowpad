"""GitHub Copilot WorkerDriver."""

from __future__ import annotations

import asyncio
import json
import logging
import re
from pathlib import Path
from typing import TYPE_CHECKING, Any, Sequence
from uuid import uuid4

from flow_sdk.api.api_types.identifier import is_valid_entity_id
from flow_sdk.builtin.agent_hook import HookEventType
from flow_sdk.builtin.agentic_process.asset_dir import AssetDir
from flow_sdk.builtin.agentic_process.cli_drivers.cli_serialization import render_shell_command
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    AgenticContext,
    AgenticProcessContextKey,
    AgentOptions,
    DeviceLoginSpec,
    ProcessHookRuntime,
    WorkerAuthResult,
    WorkerSpawnError,
    apply_worker_env,
    apply_worker_secret_env,
    latch_spawn_failure,
    restart_payload_from_cli_options,
    run_worker_auth_probe,
)
from flow_sdk.builtin.agentic_process.cli_drivers.copilot.cli import CopilotAgentOptions
from flow_sdk.builtin.agentic_process.cli_drivers.copilot.session_history import (
    copilot_session_state_root,
    copilot_transcript_path_for_process,
    find_copilot_session_jsonl,
    find_latest_copilot_session_jsonl,
    read_copilot_session_meta,
)
from flow_sdk.builtin.agentic_process.cli_drivers.copilot.session_history import (
    load_session_history as _copilot_load_session_history,
)
from flow_sdk.builtin.agentic_process.cli_drivers.copilot.session_history import (
    load_transcript_history as _copilot_load_transcript_history,
)
from flow_sdk.builtin.agentic_process.cli_drivers.copilot.status import copilot_tail_status
from flow_sdk.builtin.agentic_process.cli_drivers.copilot.stream_worker import (
    CopilotCLIStreamWorker,
)
from flow_sdk.builtin.agentic_process.process_hooks import (
    SUPPORTED_PROCESS_HOOK_EVENTS,
    build_process_hook_snapshot,
    normalize_process_hook_events,
)
from flow_sdk.builtin.flowpad_runner_wrapper import get_installed_flow_invocation
from flow_sdk.builtin.worker_status import WorkerStatus
from flow_sdk.core.flow.models.webhook_flow_data import AgentHookData
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

_PROCESS_HOOK_PLUGIN = Path(".flowpad/plugins/copilot/flowpad-process-hooks")


class CopilotDriver:
    """Vendor glue for GitHub Copilot CLI."""

    name = WorkerType.COPILOT.value
    supports_process_hooks = True
    process_hooks_use_assets = True
    preassign_interactive_session_id = True
    # Copilot's TUI treats a pasted prompt ending in \r as literal text — needs
    # a discrete Enter after the paste settles (Shell.write_then_submit).
    pty_submits_on_paste = False
    # Real Copilot CLI 1.0.70 PTY captures show the ``Session: <n> AIC used``
    # status only on the main composer screen, never on folder trust. It is a
    # stronger readiness signal than the generic prompt glyph (the trust
    # choice list has its own glyph).
    pty_composer_ready_pattern = re.compile(r"Session:[ \t\u00a0]*[0-9.,]+[ \t\u00a0]+AIC used")
    pins_resume_cwd = False  # no transcript-cwd pinning, no fork

    def cli_options(self, process: "AgenticProcess") -> CopilotAgentOptions:
        cmd = CopilotAgentOptions.from_json(process.cli_config)
        cmd.session_id = process.session_id
        cmd.workdir = process.workdir
        cmd.add_dirs = process.resolved_add_dirs
        agents_json = process.get_agents_json()
        if agents_json:
            cmd.skill_names = list(agents_json.keys())
        # Transport intent (``pty_mode``), not tab visibility, selects the argv
        # shape: PTY → interactive (no json-stream); headless → json-stream.
        if process.pty_mode:
            cmd.json_stream = False
        if process.session_id and self._has_session(process):
            cmd.resume = True
        return cmd

    def restart_snapshot(
        self,
        process: "AgenticProcess",
        options: AgentOptions,
    ) -> dict:
        return restart_payload_from_cli_options(options)

    def process_hook_snapshot(self, events: Sequence["HookEventType"]) -> dict[str, Any]:
        return build_process_hook_snapshot(events, provider=self.name)

    def prepare_process_hooks(
        self,
        assets: "AssetDir",
        process_id: str,
        events: Sequence["HookEventType"],
    ) -> ProcessHookRuntime:
        normalized = normalize_process_hook_events(events, provider=self.name)
        if not is_valid_entity_id(process_id):
            raise ValueError(f"Invalid agentic process id: {process_id!r}")
        if not normalized:
            assets.remove(_PROCESS_HOOK_PLUGIN)
            return ProcessHookRuntime()

        command, prefix_args = get_installed_flow_invocation()
        flow_argv = [
            command,
            *prefix_args,
            "hooks",
            "report",
            "--process-id",
            process_id,
        ]
        handler = {
            "type": "command",
            "bash": render_shell_command(flow_argv, "linux"),
            "powershell": render_shell_command(flow_argv, "win32"),
        }
        # Copilot accepts BOTH its own camelCase event names
        # (``userPromptSubmitted``/``sessionStart``/``sessionEnd``) and the
        # PascalCase VS Code-compatible aliases. We deliberately project the
        # aliases: on config load Copilot rewrites them to its native keys and
        # stamps ``_vsCodeCompat`` on each handler, which switches the stdin
        # payload to the Claude-shaped one — snake_case fields carrying
        # ``hook_event_name``. Copilot's native payload has no event field at
        # all, so without this one shared handler command could not tell the
        # three events apart.
        hooks = {
            "hooks": {event.value: [handler] for event in normalized},
            "version": 1,
        }
        manifest = {
            "author": {"name": "Flowpad"},
            "description": "Flowpad process-scoped hooks",
            "hooks": "hooks.json",
            "name": "flowpad-process-hooks",
            "version": "1.0.0",
        }

        assets.remove(_PROCESS_HOOK_PLUGIN)
        plugin = assets.subdir(_PROCESS_HOOK_PLUGIN)
        plugin.load_asset(
            "plugin.json",
            content=json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        )
        plugin.load_asset(
            "hooks.json",
            content=json.dumps(hooks, indent=2, sort_keys=True) + "\n",
        )
        return ProcessHookRuntime(plugin_dirs=(str(plugin.os_path),))

    def normalize_process_hook_data(
        self,
        process_id: str,
        raw_hook_data: dict[str, Any],
    ) -> "AgentHookData":
        if not is_valid_entity_id(process_id):
            raise ValueError(f"Invalid agentic process id: {process_id!r}")
        raw = dict(raw_hook_data)
        supported = {event.value for event in SUPPORTED_PROCESS_HOOK_EVENTS}
        supplied_event = raw.get("hook_event_name")
        if supplied_event is None:
            # Native (non-compat) payload: no event field exists, and only the
            # prompt hook has ever been projected that way. Anything else is a
            # payload we cannot attribute to an event.
            if "prompt" not in raw:
                raise ValueError("Copilot process hook payload carries no hook_event_name")
            supplied_event = HookEventType.USER_PROMPT_SUBMIT.value
        elif supplied_event not in supported:
            raise ValueError(f"Unsupported Copilot process hook event: {supplied_event}")

        hook_data: dict[str, Any] = {"hook_event_name": supplied_event}
        if "session_id" in raw:
            hook_data["session_id"] = raw["session_id"]
        elif "sessionId" in raw:
            hook_data["session_id"] = raw["sessionId"]
        # ``initial_prompt``/``initialPrompt`` is SessionStart's launch prompt,
        # ``source``/``reason`` the lifecycle discriminators. Vocabularies stay
        # Copilot's own; only field NAMES are canonicalized.
        for key in ("prompt", "cwd", "timestamp", "source", "reason"):
            if key in raw:
                hook_data[key] = raw[key]
        if "initial_prompt" in raw:
            hook_data["initial_prompt"] = raw["initial_prompt"]
        elif "initialPrompt" in raw:
            hook_data["initial_prompt"] = raw["initialPrompt"]
        # Copilot's headless stdin transport submits by appending one ``\n``;
        # its prompt hook echoes that transport terminator in ``prompt``. Keep
        # the native payload losslessly in ``raw_hook_data``, but remove the
        # terminator from the canonical cross-worker prompt value.
        if supplied_event == HookEventType.USER_PROMPT_SUBMIT.value and isinstance(hook_data.get("prompt"), str):
            hook_data["prompt"] = hook_data["prompt"].removesuffix("\n")
        hook_data["raw_hook_data"] = raw
        return AgentHookData(agentic_process_id=process_id, hook_data=hook_data)

    async def headless_prompt(
        self,
        process: "AgenticProcess",
        instruction: str,
    ) -> "ApiResponse":
        try:
            await process.get_project()
        except Exception:
            logger.debug("CopilotDriver.headless_prompt: get_project failed", exc_info=True)
        process_assets = await process.prepare_process_assets()
        if not process.workdir:
            return ApiFailResponse(message="copilot prompt: workdir is not set")

        # Resume ONLY when copilot actually has a session file for this id.
        # A preassigned ``session_id`` that copilot never wrote (a fresh chat
        # tab, or a PTY session killed before its first turn) must start fresh
        # WITH that id (copilot accepts a caller-provided ``--session-id``),
        # not resume a non-existent one. ``had_session`` alone (is the field
        # set?) can't tell those apart; ``has_resumable_session`` checks the file.
        resumable = self.has_resumable_session(process)
        if not process.session_id:
            process.session_id = str(uuid4())
            try:
                await process.save()
            except Exception:
                logger.debug("CopilotDriver.headless_prompt: preassign save failed", exc_info=True)

        full_prompt = self.compose_prompt(instruction, process.get_agents_json())
        cli_cfg = process.cli_config or {}
        env_vars = apply_worker_env(dict(cli_cfg.get("env_vars") or {}), process)
        await apply_worker_secret_env(env_vars, process)
        context = AgenticContext(
            workdir=process.workdir,
            env_vars=env_vars,
            model=cli_cfg.get("model"),
            permission_mode=cli_cfg.get("permission_mode", "bypassPermissions"),
            effort=cli_cfg.get("effort"),
            add_dirs=list(process.resolved_add_dirs or []),
            session_id=process.session_id if not resumable else None,
            resume_session_id=process.session_id if resumable else None,
            **process._process_asset_context_kwargs(process_assets),
        )

        worker = CopilotCLIStreamWorker.for_process(process.id)
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
            try:
                transcript_path = worker.transcript_path
                if transcript_path is not None and not transcript_path.exists():
                    transcript_path.parent.mkdir(parents=True, exist_ok=True)
                    transcript_path.touch()
            except OSError:
                logger.debug("CopilotDriver.headless_prompt: transcript pre-touch failed", exc_info=True)

            from flow_sdk.builtin.process_lifecycle import ProcessStatus

            if process.status != ProcessStatus.RUNNING.value:
                process.status = ProcessStatus.RUNNING.value
                try:
                    await process.save()
                except Exception:
                    logger.debug("CopilotDriver.headless_prompt: lifecycle save failed", exc_info=True)

            process_ref = process
            process_id = process.id
            object.__setattr__(process_ref, "_turn_in_flight", True)
            try:
                await process_ref.notify_updated()
            except Exception:
                logger.exception("CopilotDriver.headless_prompt: start notify failed")

            # Session adoption (and its restart-snapshot bookkeeping) is owned by
            # AgenticProcess.adopt_worker_session; the turn-scoped adopter trusts
            # only the turn-initial report (spurious-rotation guard). Resumed
            # sessions no-op inside adopt_worker_session when the id is unchanged.
            adopt_session = process_ref.make_turn_session_adopter("CopilotDriver.headless_prompt")

            async def _run_turn() -> None:
                try:
                    async for fd in worker.execute(prompt=full_prompt, context=context):
                        await adopt_session(worker.get_session_id())
                        try:
                            await process_ref.emit_flow_data(fd.model_dump())
                        except Exception:
                            logger.debug("CopilotDriver.headless_prompt: emit_flow_data failed", exc_info=True)
                except WorkerSpawnError as e:
                    # No subprocess ever started — end the process FAILED with the
                    # start_failure latch (the ERROR frame was already emitted).
                    await latch_spawn_failure(process_ref, e)
                except Exception:
                    logger.exception("CopilotDriver.headless_prompt: worker error")
                finally:
                    unregister_prompt_worker(process_id, worker)
                    # Terminal status broadcast + completion-driven queue advance
                    # (see AgenticProcess.end_headless_turn).
                    await process_ref.end_headless_turn("CopilotDriver.headless_prompt")

            asyncio.create_task(_run_turn(), name=f"copilot-{process.id[:8]}")
        except BaseException:
            # _run_turn never took ownership of the slot — release it here so the
            # next turn is not permanently rejected with a 409.
            unregister_prompt_worker(process.id, worker)
            raise
        return ApiSuccessResponse(data={"status": "started", "worker": self.name})

    def stream_worker(self, process: "AgenticProcess") -> CopilotCLIStreamWorker:
        return CopilotCLIStreamWorker.for_process(process.id)

    async def auth_probe(self) -> WorkerAuthResult:
        """Copilot has no status subcommand — heuristic probe (env token /
        ``~/.copilot/config.json`` marker), never ``verified``. The shared
        runner's install gate still applies: an uninstalled CLI reports
        NOT_INSTALLED even when a GH_TOKEN happens to be in the env."""
        return await run_worker_auth_probe(self.name)

    # RFC-8628 device flow — copilot's default and only login mode.
    device_login_spec = DeviceLoginSpec(
        login_argv=("copilot", "login"),
        url_re=re.compile(r"(https://github\.com/login/device)"),
        code_re=re.compile(r"enter (?:the )?code ([A-Z0-9]{4}-[A-Z0-9]{4})"),
        accepts_code_paste=False,
    )

    def transcript_descriptor(self, process: "AgenticProcess") -> TranscriptDescriptor | None:
        """Resolve the Copilot transcript for READING (history / prompts / status).

        Transcript↔output alignment (mirror of codex): the session record
        (``~/.copilot/session-state/<id>/events.jsonl``) is the canonical, complete
        transcript — user-message entries AND assistant output. The process-local
        file is only the tee'd stdout (assistant output, no user-message entry), so
        ``transcript/prompts`` came back empty for headless. Prefer the exact session
        record for an assigned id; use bounded latest-session discovery only for a
        legacy process without an id, then fall back to that process's stdout tee.
        """
        session = self._session_descriptor(process)
        if session is not None:
            return session
        return self._process_local_descriptor(process)

    def transcript_path(self, process: "AgenticProcess") -> Path | None:
        descriptor = self.transcript_descriptor(process)
        return descriptor.path if descriptor else None

    def skills_root(self, process: "AgenticProcess", assets_dir: Path) -> Path:
        """Copilot discovers skills from ``.claude/skills`` under the mounted
        assets dir (passed via ``--add-dir``)."""
        return assets_dir / ".claude" / "skills"

    def _process_local_descriptor(self, process: "AgenticProcess") -> TranscriptDescriptor | None:
        path = copilot_transcript_path_for_process(process.id)
        if not path.exists():
            return None
        return TranscriptDescriptor(
            path=path,
            format=TranscriptFormat.COPILOT_STREAM,
            source=TranscriptSource.PROCESS_LOCAL,
            session_id=process.session_id or "",
        )

    def _session_descriptor(self, process: "AgenticProcess") -> TranscriptDescriptor | None:
        if process.session_id:
            path = find_copilot_session_jsonl(process.session_id)
        else:
            path = find_latest_copilot_session_jsonl(
                cwd=process.workdir,
                started_at=self._worker_started_at(process),
            )
        if path is None or not path.exists():
            return None
        meta = read_copilot_session_meta(path)
        return TranscriptDescriptor(
            path=path,
            format=TranscriptFormat.COPILOT_EVENTS,
            source=TranscriptSource.WORKER_SESSION,
            session_id=str(meta.get("id") or process.session_id or ""),
        )

    def _worker_started_at(self, process: "AgenticProcess") -> str | None:
        context = process.context_data or {}
        value = context.get(AgenticProcessContextKey.WORKER_STARTED_AT.value)
        return str(value) if value else None

    def tail_status(self, transcript_path: Path) -> WorkerStatus:
        return copilot_tail_status(transcript_path)

    def has_resumable_session(self, process: "AgenticProcess") -> bool:
        return self._has_session(process)

    def supports_plan_mode(self, process: "AgenticProcess") -> bool:
        # Copilot has no CLI plan-mode equivalent yet; tracked as a follow-up.
        return False

    def load_history(self, process: "AgenticProcess") -> list["FlowData"]:
        descriptor = self.transcript_descriptor(process)
        if descriptor is not None:
            return _copilot_load_transcript_history(
                descriptor.path,
                transcript_format=descriptor.format,
            )
        return _copilot_load_session_history(process.session_id or "", process_id=process.id)

    def compose_prompt(self, instruction: str, agents_json: dict | None) -> str:
        return instruction

    def external_session_dirs(self) -> set[str]:
        root = copilot_session_state_root()
        if not root.is_dir():
            return set()
        return {p.name for p in root.iterdir() if p.is_dir()}

    def _has_session(self, process: "AgenticProcess") -> bool:
        if not process.session_id:
            return False
        return find_copilot_session_jsonl(process.session_id) is not None
