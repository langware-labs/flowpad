"""Claude Code WorkerDriver — vendor glue for the AgenticProcess driver layer.

Concentrates everything previously expressed as ``if worker_type == CLAUDE_CODE``
in ``AgenticProcess`` so the entity stays vendor-pure: cli_options building,
headless print-mode turn execution (``claude -p stream-json``), transcript
location, history loading, and the prompt-composition compatibility hook.
"""

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
from flow_sdk.builtin.agentic_process.cli_drivers.claude.cli import ClaudeAgentOptions
from flow_sdk.builtin.agentic_process.cli_drivers.claude.session_history import (
    load_session_history as _claude_load_session_history,
)
from flow_sdk.builtin.agentic_process.cli_drivers.claude.stream_worker import (
    ClaudeCLIStreamWorker,
)
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    AgenticContext,
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
from flow_sdk.builtin.agentic_process.process_hooks import (
    build_process_hook_snapshot,
    normalize_process_hook_events,
)
from flow_sdk.builtin.flowpad_runner_wrapper import get_installed_flow_invocation
from flow_sdk.builtin.worker_status import WorkerStatus, _tail_status
from flow_sdk.core.flow.models.webhook_flow_data import AgentHookData
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

_PROCESS_HOOK_PLUGIN = Path(".flowpad/plugins/claude/flowpad-process-hooks")
# Module-level cache of in-flight workers (looked up for cancel-prompt).
# Shared with the codex driver via ``AgenticProcess._PROMPT_WORKERS`` —
# the entity owns the dict, drivers just register/deregister.


class ClaudeDriver:
    """Vendor glue for Claude Code. Implements the ``WorkerDriver`` Protocol."""

    name = "claude"
    supports_process_hooks = True
    process_hooks_use_assets = True
    preassign_interactive_session_id = True
    pty_submits_on_paste = True
    # Real Claude Code PTY captures expose two grounded blank-composer frames:
    # a fresh boot paints the rotating ``Try "…"`` placeholder (2.1.207+),
    # while a resumed session can paint a bare prompt followed immediately by
    # the composer rule (2.1.220+). The welcome banner and echoed user prompts
    # match neither form, so they cannot release typed delivery prematurely.
    # Accept either the regular or non-breaking space Claude paints after the
    # prompt glyph.
    pty_composer_ready_pattern = re.compile(r'❯[ \t\u00a0]+(?:Try "|─{3,})')
    pins_resume_cwd = True  # pins CLAUDE_PROJECT_DIR + workdir to the source session's cwd

    # ── CLI shape ────────────────────────────────────────────────────────────

    def cli_options(self, process: "AgenticProcess") -> ClaudeAgentOptions:
        """Build a Claude CLI command for ``process``.

        Injects ``--add-dir`` for the Flowpad Assistant project (so SDK-shipped
        skills / agents are discoverable) plus any ``additional_dirs``;
        registers embedded sub-agents via ``--agents``; sets ``CLAUDE_PROJECT_DIR``
        env from the workdir.

        The Flowpad Assistant mount is gated by ``process.assistant_enabled`` —
        the per-process ``load_flowpad_assistant`` flag, falling back to the
        global ``ServiceConfig.load_flowpad_assistant``. Set the flag (e.g.
        ``process.enable_assistant()``) to override per process; ``None`` keeps
        the global default.
        """
        cmd = ClaudeAgentOptions.from_json(process.cli_config)
        cmd.session_id = process.session_id
        cmd.workdir = process.workdir
        if cmd.session_id and self.transcript_path(process) is not None:
            cmd.resume = True
            cmd.fork_session_id = None
        if cmd.workdir:
            cmd.env_vars.setdefault("CLAUDE_PROJECT_DIR", cmd.workdir)
        cmd.add_dirs = process.resolved_add_dirs
        agents_json = process.get_agents_json()
        if agents_json:
            cmd.agents_json = agents_json
        return cmd

    def restart_snapshot(
        self,
        process: "AgenticProcess",
        options: AgentOptions,
    ) -> dict:
        return restart_payload_from_cli_options(options)

    def process_hook_snapshot(self, events: Sequence[HookEventType]) -> dict[str, Any]:
        return build_process_hook_snapshot(events, provider=self.name)

    def prepare_process_hooks(
        self,
        assets: AssetDir,
        process_id: str,
        events: Sequence[HookEventType],
    ) -> ProcessHookRuntime:
        normalized = normalize_process_hook_events(events, provider=self.name)
        if not normalized:
            assets.remove(_PROCESS_HOOK_PLUGIN)
            return ProcessHookRuntime()
        if not is_valid_entity_id(process_id):
            raise ValueError(f"Invalid agentic process id: {process_id!r}")

        command, prefix_args = get_installed_flow_invocation()
        handler = {
            "args": [*prefix_args, "hooks", "report", "--process-id", process_id],
            "command": command,
            "type": "command",
        }
        hooks = {
            "description": "Flowpad process-scoped hooks",
            "hooks": {event.value: [{"hooks": [handler]}] for event in normalized},
        }
        manifest = {
            "author": {"name": "Flowpad"},
            "description": "Flowpad process-scoped hooks",
            "name": "flowpad-process-hooks",
            "version": "1.0.0",
        }

        assets.remove(_PROCESS_HOOK_PLUGIN)
        plugin = assets.subdir(_PROCESS_HOOK_PLUGIN)
        plugin.load_asset(
            ".claude-plugin/plugin.json",
            content=json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        )
        plugin.load_asset(
            "hooks/hooks.json",
            content=json.dumps(hooks, indent=2, sort_keys=True) + "\n",
        )
        return ProcessHookRuntime(plugin_dirs=(str(plugin.os_path),))

    def normalize_process_hook_data(
        self,
        process_id: str,
        raw_hook_data: dict[str, Any],
    ) -> AgentHookData:
        if not is_valid_entity_id(process_id):
            raise ValueError(f"Invalid agentic process id: {process_id!r}")
        raw = dict(raw_hook_data)
        # ``source`` (SessionStart) and ``reason`` (SessionEnd) are the two
        # lifecycle discriminators; every other vendor field stays in
        # ``raw_hook_data``. Values are passed through, not translated — each
        # vendor keeps its own ``source``/``reason`` vocabulary.
        canonical_fields = (
            "hook_event_name",
            "prompt",
            "session_id",
            "cwd",
            "transcript_path",
            "source",
            "reason",
        )
        hook_data = {key: raw[key] for key in canonical_fields if key in raw}
        hook_data["raw_hook_data"] = raw
        return AgentHookData(agentic_process_id=process_id, hook_data=hook_data)

    # ── Per-turn execution ───────────────────────────────────────────────────

    async def headless_prompt(
        self,
        process: "AgenticProcess",
        instruction: str,
    ) -> "ApiResponse":
        """Headless ``claude -p stream-json`` execution for invisible processes.

        Spawns ``ClaudeCLIStreamWorker``, captures the session_id emitted in
        the first ``system:init`` event onto ``process.session_id``, and writes
        the standard JSONL transcript to
        ``~/.claude/projects/<encoded-cwd>/<session-id>.jsonl``.

        ``-p`` mode keeps Claude iterating until ``end_turn``, which is
        required for multi-step prompts (the legacy PTY path forces single-tool
        turns).
        """
        try:
            await process.get_project()
        except Exception:
            logger.debug("ClaudeDriver.headless_prompt: get_project failed", exc_info=True)
        process_assets = await process.prepare_process_assets()
        if not process.workdir:
            return ApiFailResponse(message="claude print prompt: workdir is not set")

        # Eagerly assign a session_id so ``is_ready_for_input`` flips to False
        # before the worker writes its first JSONL entry — matches the
        # behaviour the legacy PTY path provides via ``start()``.
        if not process.session_id:
            process.session_id = str(uuid4())

        cli_cfg = process.cli_config or {}
        # Multi-turn: if the session already wrote a transcript on a prior
        # turn, ``--session-id`` would error ("session already exists") so we
        # have to flip into ``--resume`` mode. ``cli_config["resume"]`` honours
        # explicit caller intent; the transcript check covers in-process
        # multi-turn against the same entity.
        is_resume = bool(cli_cfg.get("resume")) or self.transcript_path(process) is not None
        # Fork: caller asked to branch off ``fork_session_id`` into a new
        # session-id (cli_options sets ``cmd.fork_session_id``). When present,
        # we resume from the source and tell the worker to fork; the new
        # session id is ``process.session_id``.
        # Once the fork has already materialised on disk, the new session
        # is no longer "new" — re-issuing ``--fork-session --session-id <existing>``
        # errors with "Session ID is already in use". Drop the fork source
        # so this turn plain-resumes the materialised session instead.
        fork_source = cli_cfg.get("fork_session_id")
        if fork_source and self.transcript_path(process) is not None:
            fork_source = None
        # Default the headless parent to sonnet — opus's parent-side latency
        # blows past the 28-s long-test budget on multi-step flows. Callers
        # can override via cli_config["model"] / ["effort"].
        parent_model = cli_cfg.get("model") or "sonnet"
        parent_effort = cli_cfg.get("effort")
        # Mirror PTY path's FLOWPAD_EXECUTION_SCOPE injection
        # (agentic_process.py:786-788) so headless workers can route
        # CLI calls (e.g. ``flow record``) back to this process.
        env_vars = apply_worker_env(dict(cli_cfg.get("env_vars") or {}), process)
        await apply_worker_secret_env(env_vars, process)

        context = AgenticContext(
            workdir=process.workdir,
            env_vars=env_vars,
            model=parent_model,
            effort=parent_effort,
            permission_mode=cli_cfg.get("permission_mode", "bypassPermissions"),
            resume_session_id=(fork_source or process.session_id) if (is_resume or fork_source) else None,
            session_id=process.session_id if fork_source else (None if is_resume else process.session_id),
            fork_session=bool(fork_source),
            add_dirs=process.resolved_add_dirs,
            **process._process_asset_context_kwargs(process_assets),
        )

        # Lifecycle: flip to RUNNING before launching the worker.
        from flow_sdk.builtin.process_lifecycle import ProcessStatus

        if process.status != ProcessStatus.RUNNING.value:
            process.status = ProcessStatus.RUNNING.value
            try:
                await process.save()
            except Exception:
                # WARNING so headless / migration callers can observe that
                # lifecycle state isn't being persisted. See the matching
                # change at agentic_process.py:_run_turn.
                logger.warning(
                    "ClaudeDriver.headless_prompt: lifecycle save failed",
                    exc_info=True,
                )

        worker = ClaudeCLIStreamWorker()
        from flow_sdk.builtin.agentic_process.agentic_process import (
            register_prompt_worker,
            unregister_prompt_worker,
        )

        register_prompt_worker(process.id, worker)
        # Setup between registration and task scheduling can raise (compose_prompt
        # / get_agents_json / make_turn_session_adopter). The caller's admission
        # ``finally`` can no longer clean the slot — register_prompt_worker popped
        # the admission and moved ownership to ``_PROMPT_WORKERS``. Until _run_turn
        # is scheduled (and its own ``finally`` owns unregister), THIS frame owns
        # the worker slot: a raise here would otherwise leak it → prompt_worker_active
        # pinned True forever (permanent 409 + busy). Hand ownership off on success.
        try:
            composed = self.compose_prompt(instruction, process.get_agents_json())
            process_ref = process
            process_id = process.id

            # Multi-turn correctness: see AgenticProcess._discover_status_from_transcript.
            # Flip the projection to RUNNING for the duration of this turn and
            # broadcast it now so the closing notify_updated (which carries the
            # JSONL-derived COMPLETE) is a real edge for SDK mirrors.
            object.__setattr__(process_ref, "_turn_in_flight", True)
            try:
                await process_ref.notify_updated()
            except Exception:
                logger.exception("ClaudeDriver.headless_prompt: start-of-turn notify_updated failed")

            # Session adoption (and its restart-snapshot bookkeeping) is owned by
            # AgenticProcess.adopt_worker_session; the turn-scoped adopter trusts
            # only the turn-initial report (spurious-rotation guard).
            adopt_session = process_ref.make_turn_session_adopter("ClaudeDriver.headless_prompt")

            async def _run_turn() -> None:
                try:
                    async for fd in worker.execute(prompt=composed, context=context):
                        await adopt_session(worker.get_session_id())
                        try:
                            await process_ref.emit_flow_data(fd.model_dump())
                        except Exception:
                            logger.exception("ClaudeDriver.headless_prompt: emit_flow_data failed")
                except WorkerSpawnError as e:
                    # No subprocess ever started — end the process FAILED with the
                    # start_failure latch (the ERROR frame was already emitted).
                    await latch_spawn_failure(process_ref, e)
                except Exception:
                    logger.exception("ClaudeDriver.headless_prompt: worker error")
                finally:
                    unregister_prompt_worker(process_id, worker)
                    # If the fork materialised on disk (the new session's JSONL
                    # was written), drop ``fork_session_id`` from cli_config so
                    # subsequent launches plain ``--resume`` the new session
                    # instead of trying to re-fork from the parent — which
                    # errors with "Session ID is already in use" against the
                    # now-existing new session. Guarded by transcript existence
                    # so an early-failed fork keeps the parent reference for
                    # retry.
                    if self.transcript_path(process_ref) is not None:
                        cli_cfg_next = dict(process_ref.cli_config or {})
                        if cli_cfg_next.pop("fork_session_id", None) is not None:
                            process_ref.cli_config = cli_cfg_next
                            try:
                                await process_ref.save()
                            except Exception:
                                logger.debug("ClaudeDriver.headless_prompt: fork-strip save failed", exc_info=True)
                    # Terminal status broadcast + completion-driven queue advance
                    # (see AgenticProcess.end_headless_turn).
                    await process_ref.end_headless_turn("ClaudeDriver.headless_prompt")

            asyncio.create_task(_run_turn(), name=f"claude-{process.id[:8]}")
        except BaseException:
            # _run_turn never took ownership of the slot — release it here so the
            # next turn is not permanently rejected with a 409.
            unregister_prompt_worker(process.id, worker)
            raise
        return ApiSuccessResponse(data={"status": "started", "worker": self.name})

    def stream_worker(self, process: "AgenticProcess") -> ClaudeCLIStreamWorker:
        return ClaudeCLIStreamWorker()

    async def report_event(
        self,
        process: "AgenticProcess",
        name,
        data: dict,
    ) -> dict:
        return {
            "handled": False,
            "worker": self.name,
            "event_name": getattr(name, "value", str(name)),
            "session_id": process.session_id,
            "reason": "unsupported_event",
        }

    # ── Auth ─────────────────────────────────────────────────────────────────

    async def auth_probe(self) -> WorkerAuthResult:
        """`claude auth status` against the discovered CLI (JSON `loggedIn`)."""
        return await run_worker_auth_probe(self.name)

    # Auth-code + PKCE: the browser shows a code the user pastes BACK into the
    # CLI (no device-flow user_code in the terminal output).
    device_login_spec = DeviceLoginSpec(
        login_argv=("claude", "auth", "login"),
        url_re=re.compile(r"(https://(?:\S*\.)?(?:claude\.(?:ai|com)|anthropic\.com)/\S*oauth\S+)"),
        code_re=None,
        accepts_code_paste=True,
    )

    # ── Transcript discovery ─────────────────────────────────────────────────

    def transcript_descriptor(self, process: "AgenticProcess") -> TranscriptDescriptor | None:
        """Path to the Claude session JSONL — None when no session_id yet."""
        if not process.session_id:
            return None
        from flow_sdk.fs_store.indexer.functions.claude_sessions import get_claude_session

        record = get_claude_session(process.session_id)
        if record and record.jsonl_path:
            path = Path(record.jsonl_path)
            if path.exists():
                return TranscriptDescriptor(
                    path=path,
                    format=TranscriptFormat.CLAUDE_JSONL,
                    source=TranscriptSource.WORKER_SESSION,
                    session_id=process.session_id,
                )
        return None

    def transcript_path(self, process: "AgenticProcess") -> Path | None:
        descriptor = self.transcript_descriptor(process)
        return descriptor.path if descriptor else None

    def skills_root(self, process: "AgenticProcess", assets_dir: Path) -> Path:
        """Claude discovers skills from ``.claude/skills`` under the mounted
        assets dir (passed via ``--add-dir``)."""
        return assets_dir / ".claude" / "skills"

    def tail_status(self, transcript_path: Path) -> WorkerStatus:
        """Map the tail of the Claude JSONL to a WorkerStatus."""
        return _tail_status(transcript_path)

    def has_resumable_session(self, process: "AgenticProcess") -> bool:
        from flow_sdk.fs_store.indexer.functions.claude_sessions import get_claude_session

        return bool(process.session_id) and get_claude_session(process.session_id) is not None

    def supports_plan_mode(self, process: "AgenticProcess") -> bool:
        """Claude supports CLI plan mode (``--permission-mode plan`` + the
        ``ExitPlanMode``/``AskUserQuestion`` tools) in headless turns."""
        return True

    # ── History materialisation ──────────────────────────────────────────────

    def load_history(self, process: "AgenticProcess") -> list["FlowData"]:
        if not process.session_id:
            return []
        return _claude_load_session_history(process.session_id)

    # ── Prompt composition ───────────────────────────────────────────────────

    def compose_prompt(
        self,
        instruction: str,
        agents_json: dict | None,
    ) -> str:
        return instruction

    # ── External-session probe ───────────────────────────────────────────────

    def external_session_dirs(self) -> set[str]:
        """Snapshot of ``~/.claude/projects/`` entries that encode an
        agentic-process records path. Tests assert this set doesn't grow.
        """
        from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

        claude_projects = get_instance_settings().claude_projects_dir
        if not claude_projects.is_dir():
            return set()
        return {d.name for d in claude_projects.iterdir() if d.is_dir() and "flow-records-agentic" in d.name}
