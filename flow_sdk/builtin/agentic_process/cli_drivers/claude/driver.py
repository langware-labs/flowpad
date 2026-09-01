"""Claude Code WorkerDriver — vendor glue for the AgenticProcess driver layer.

Concentrates everything previously expressed as ``if worker_type == CLAUDE_CODE``
in ``AgenticProcess`` so the entity stays vendor-pure: cli_options building,
headless print-mode turn execution (``claude -p stream-json``), transcript
location, history loading, and the prompt-composition compatibility hook.
"""

from __future__ import annotations

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
    AgentOptions,
    AgenticContext,
    DeviceLoginSpec,
    ProcessHookRuntime,
    ProcessMcpRuntime,
    WorkerAuthResult,
    apply_worker_env,
    apply_worker_secret_env,
    restart_payload_from_cli_options,
    run_worker_auth_probe,
)
from flow_sdk.builtin.agentic_process.cli_drivers.mcp_projection import (
    to_mcp_config_json,
)
from flow_sdk.builtin.agentic_process.cli_drivers.headless_turn import run_headless_turn
from flow_sdk.builtin.agentic_process.process_hooks import (
    build_canonical_hook_data,
    build_process_hook_snapshot,
    normalize_process_hook_events,
)
from flow_sdk.builtin.flowpad_runner_wrapper import get_installed_flow_invocation
from flow_sdk.builtin.hooks.capabilities import process_capability, settings_file_scopes
from flow_sdk.builtin.hooks.types import (
    AgentHookResponse,
    BlockResponse,
    ContextResponse,
    HookCapabilities,
    HookOutcome,
    HookScope,
    PermissionResponse,
)
from flow_sdk.builtin.worker_status import WorkerStatus, _tail_status
from flow_sdk.core.flow.models.webhook_flow_data import AgentHookData
from flow_sdk.flowpad_types.vendors import vendor_for
from flow_sdk.responses.response import ApiFailResponse
from flow_sdk.transcript_analyzer import (
    TranscriptDescriptor,
    TranscriptFormat,
    TranscriptSource,
)

VENDOR = vendor_for("claude")

if TYPE_CHECKING:
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData
    from flow_sdk.responses.response import ApiResponse
    from flow_sdk.schema.data_spec.mcp_spec import McpSpec

logger = logging.getLogger(__name__)

_PROCESS_HOOK_PLUGIN = Path(".flowpad/plugins/claude/flowpad-process-hooks")
_CANONICAL_FIELDS = (
    "hook_event_name",
    "prompt",
    "session_id",
    "cwd",
    "transcript_path",
    "source",
    "reason",
)
# Module-level cache of in-flight workers (looked up for cancel-prompt).
# Shared with the codex driver via ``AgenticProcess._PROMPT_WORKERS`` —
# the entity owns the dict, drivers just register/deregister.


#: Events whose handler STDOUT Claude reads back. ``SessionEnd`` is absent —
#: Claude defines no output shape for it (see ``hook_events.py``), so a decision
#: there would be silently discarded, which is worse than refusing it.
_RESPONSE_EVENTS = frozenset({HookEventType.USER_PROMPT_SUBMIT, HookEventType.SESSION_START})

#: Claude is the only harness with both halves: a settings file it discovers at
#: three scopes, and a plugin directory we hand over at launch.
_HOOK_CAPABILITIES: "HookCapabilities" = {
    **settings_file_scopes(),
    HookScope.PROCESS: process_capability(response_events=_RESPONSE_EVENTS),
}


class ClaudeDriver:
    """Vendor glue for Claude Code. Implements the ``WorkerDriver`` Protocol."""

    name = VENDOR.key
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
        # Pin the host terminal's palette. Claude paints in truecolor (Flowpad
        # sets COLORTERM=truecolor), so none of its foregrounds are ANSI-indexed
        # and swapping xterm's 16-slot theme host-side recolors nothing — the RGB
        # values come from Claude's own theme setting, read once at launch. Left
        # unset, a worker in a light terminal inherits the user's global (usually
        # dark) theme and paints #999999/#b1b9f9 on white. ``--settings`` is a
        # per-process layer, so this never touches ~/.claude/settings.json.
        # How a theme reaches a given CLI is that vendor's business: Claude has a
        # first-class ``theme`` setting; codex/copilot/opencode are unaddressed.
        if process.terminal_theme:
            cmd.settings_json = {**(cmd.settings_json or {}), "theme": process.terminal_theme}
        return cmd

    def restart_snapshot(
        self,
        process: "AgenticProcess",
        options: AgentOptions,
    ) -> dict:
        return restart_payload_from_cli_options(options)

    def process_hook_snapshot(self, events: Sequence[HookEventType]) -> dict[str, Any]:
        return build_process_hook_snapshot(events, provider=self.name)

    def hook_capabilities(self) -> "HookCapabilities":
        return dict(_HOOK_CAPABILITIES)

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

        def _handler(event: HookEventType) -> dict[str, Any]:
            """One handler per event.

            ``--wait-for-response`` is added ONLY for events whose stdout Claude
            reads. It makes the CLI block on a backend round trip, so paying it
            for a fire-and-forget event would be pure latency on every hook.
            """
            args = [*prefix_args, "hooks", "report", "--process-id", process_id]
            if event in _RESPONSE_EVENTS:
                args.append("--wait-for-response")
            return {"args": args, "command": command, "type": "command"}

        hooks = {
            "description": "Flowpad process-scoped hooks",
            "hooks": {event.value: [{"hooks": [_handler(event)]}] for event in normalized},
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

    # ── Per-process MCP ──────────────────────────────────────────────────
    supports_process_mcp = True

    def prepare_process_mcp(self, specs: "Sequence[McpSpec]") -> ProcessMcpRuntime:
        """``--mcp-config <json>`` + ``--strict-mcp-config``.

        ``--mcp-config`` accepts a JSON string as well as a file path, so this
        writes nothing to disk. ``strict`` is on whenever the process has an
        attached set: without it the worker gets this set PLUS everything in
        ``~/.claude.json``, and "which MCP servers does this process have"
        stops having an answer.
        """
        if not specs:
            return ProcessMcpRuntime()
        return ProcessMcpRuntime(mcp_config_json=to_mcp_config_json(specs))

    def normalize_process_hook_data(
        self,
        process_id: str,
        raw_hook_data: dict[str, Any],
    ) -> AgentHookData:
        return build_canonical_hook_data(process_id, raw_hook_data, fields=_CANONICAL_FIELDS)

    def render_hook_response(
        self,
        event: HookEventType,
        response: "AgentHookResponse",
    ) -> HookOutcome:
        """Render a typed answer into Claude's hook-output JSON.

        Shapes come from Claude's documented hook outputs: ``hookSpecificOutput``
        carries per-event fields, while ``decision``/``reason`` sit at the top
        level. See ``setup_cmd/claude_code_setup/hook_events.py`` for the models.

        Always exit 0. Claude reads a decision straight out of stdout JSON, so
        the exit-2 blocking channel buys nothing here — and a stray non-zero
        would block the turn.
        """
        if event not in _RESPONSE_EVENTS:
            raise NotImplementedError(
                f"claude reads no hook output for {event.value} — a decision there would be discarded"
            )

        if isinstance(response, ContextResponse):
            if response.block:
                return HookOutcome(stdout={"decision": "block", "reason": response.reason})
            if not response.additional_context:
                return HookOutcome()
            return HookOutcome(
                stdout={
                    "hookSpecificOutput": {
                        "hookEventName": event.value,
                        "additionalContext": response.additional_context,
                    }
                }
            )
        if isinstance(response, BlockResponse):
            if not response.block:
                return HookOutcome()
            return HookOutcome(stdout={"decision": "block", "reason": response.reason})
        if isinstance(response, PermissionResponse):
            return HookOutcome(
                stdout={
                    "hookSpecificOutput": {
                        "hookEventName": event.value,
                        "permissionDecision": str(response.behavior),
                        "permissionDecisionReason": response.reason,
                    }
                }
            )
        raise NotImplementedError(f"unrenderable hook response: {type(response).__name__}")

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

        from flow_sdk.builtin.agentic_process.cli_drivers import api_auth  # noqa: PLC0415

        await api_auth.stamp_api_model(context, process)

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
        composed = self.compose_prompt(instruction, process.get_agents_json())

        async def _strip_materialised_fork() -> None:
            """Drop ``fork_session_id`` once the fork's JSONL exists on disk.

            Subsequent launches then plain ``--resume`` the new session instead
            of re-forking from the parent, which errors with "Session ID is
            already in use" against the now-existing new session. Guarded by
            transcript existence so an early-failed fork keeps the parent
            reference for retry.
            """
            if self.transcript_path(process) is None:
                return
            cli_cfg_next = dict(process.cli_config or {})
            if cli_cfg_next.pop("fork_session_id", None) is not None:
                process.cli_config = cli_cfg_next
                try:
                    await process.save()
                except Exception:
                    logger.debug("ClaudeDriver.headless_prompt: fork-strip save failed", exc_info=True)

        # The three non-default arguments are claude's documented divergences;
        # each is explained once, on run_headless_turn's own docstring.
        return await run_headless_turn(
            self,
            process,
            worker,
            prompt=composed,
            context=context,
            logger=logger,
            save_running_status=False,
            emit_failure_level=logging.ERROR,
            on_turn_finally=_strip_materialised_fork,
        )

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


#: The class ``get_driver`` instantiates for this vendor (looked up by ``VENDORS[...].package``).
DRIVER = ClaudeDriver
