"""OpenCode WorkerDriver."""

from __future__ import annotations

import logging
import re
from collections.abc import Sequence
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING

from flow_sdk.api.api_types.identifier import is_valid_entity_id
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    AgentOptions,
    AgenticContext,
    AgenticProcessContextKey,
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
    to_opencode_mcp,
)
from flow_sdk.builtin.agentic_process.cli_drivers.headless_turn import run_headless_turn
from flow_sdk.builtin.agentic_process.cli_drivers.opencode.cli import OpenCodeAgentOptions
from flow_sdk.builtin.agentic_process.cli_drivers.opencode.config_gen import (
    SKILLS_SUBDIR,
    config_for_assets_dir,
)
from flow_sdk.builtin.agentic_process.cli_drivers.opencode.hook_plugin import (
    PLUGIN_SUBDIR,
    plugin_path,
    render_plugin,
)
from flow_sdk.builtin.agentic_process.cli_drivers.opencode.session_history import (
    assemble_session_jsonl,
    external_session_ids,
    find_latest_opencode_session,
    find_opencode_session,
    opencode_transcript_path_for_process,
)
from flow_sdk.builtin.agentic_process.cli_drivers.opencode.session_history import (
    load_session_history as _opencode_load_session_history,
)
from flow_sdk.builtin.agentic_process.cli_drivers.opencode.session_history import (
    load_transcript_history as _opencode_load_transcript_history,
)
from flow_sdk.builtin.agentic_process.cli_drivers.opencode.status import opencode_tail_status
from flow_sdk.builtin.agentic_process.cli_drivers.opencode.stream_worker import (
    OpenCodeCLIStreamWorker,
)
from flow_sdk.builtin.agentic_process.process_hooks import (
    build_process_hook_snapshot,
    normalize_process_hook_events,
)
from flow_sdk.builtin.flowpad_runner_wrapper import get_installed_flow_invocation
from flow_sdk.builtin.hooks.types import HookCapabilities, HookCapability, HookEventType, HookScope
from flow_sdk.builtin.worker_status import WorkerStatus
from flow_sdk.core.flow.models.webhook_flow_data import AgentHookData
from flow_sdk.flowpad_types.vendors import vendor_for
from flow_sdk.responses.response import ApiFailResponse
from flow_sdk.transcript_analyzer import (
    TranscriptDescriptor,
    TranscriptFormat,
    TranscriptSource,
)

VENDOR = vendor_for("opencode")

if TYPE_CHECKING:
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.builtin.agentic_process.asset_dir import AssetDir
    from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData
    from flow_sdk.responses.response import ApiResponse
    from flow_sdk.schema.data_spec.mcp_spec import McpSpec

logger = logging.getLogger(__name__)


#: OpenCode reaches its plugin through the generated ``opencode.json`` rather
#: than argv, so Process scope works with no CLI flag at all. Global scopes are
#: reachable in principle — ``.opencode/plugin/*.js`` is auto-discovered at both
#: the config home and the repo — but are not wired yet.
#:
#: ``SessionEnd`` is deliberately absent: opencode's ``session.idle`` fires at
#: TURN end, not session end, so mapping it would fire SessionEnd on every turn.
_HOOK_CAPABILITIES: "HookCapabilities" = {
    HookScope.PROCESS: HookCapability(
        events=frozenset({HookEventType.USER_PROMPT_SUBMIT, HookEventType.SESSION_START}),
    ),
}


class OpenCodeDriver:
    """Vendor glue for the OpenCode CLI."""

    name = VENDOR.key

    # ``--session`` only CONTINUES an existing session: opencode exits 1 with
    # "Session not found" for an id it has never seen, so a caller-minted uuid
    # cannot be handed over at launch. The real ``ses_…`` id is captured from the
    # first ``step_start`` instead — the same shape as codex's rollout id, which
    # is why (like codex) this driver omits ``preassign_interactive_session_id``.

    # Measured on 1.18.16: a pasted prompt ending in \r submits itself — the TUI
    # created a real session from a single paste write. OpenCode sides with
    # claude here, not with codex/copilot.
    pty_submits_on_paste = True
    # The composer's placeholder. OpenCode paints no directory-trust or
    # first-run interstitial (verified against a pristine XDG data home), so
    # this marker is unambiguous: it appears only once input is accepted.
    pty_composer_ready_pattern = re.compile(r"Ask anything")
    # Ctrl-C QUITS opencode's TUI — measured on 1.18.16: a single \x03 mid-turn
    # exits the process, which printed its ``opencode -s <id>`` resume hint. So
    # the shared cancel path's Ctrl-C did not interrupt the turn, it destroyed the
    # session. Escape stops generation and leaves the composer up.
    pty_interrupt_sequence = b"\x1b"
    pins_resume_cwd = False  # no transcript-cwd pinning

    # ------------------------------------------------------------------
    # CLI shape
    # ------------------------------------------------------------------

    def cli_options(self, process: "AgenticProcess") -> OpenCodeAgentOptions:
        cmd = OpenCodeAgentOptions.from_json(process.cli_config)
        cmd.session_id = process.session_id
        cmd.workdir = process.workdir
        cmd.add_dirs = process.resolved_add_dirs
        agents_json = process.get_agents_json()
        if agents_json:
            cmd.skill_names = list(agents_json.keys())
        # Transport intent (``pty_mode``), not tab visibility, selects the argv
        # shape: PTY → interactive TUI; headless → ``run --format json``.
        if process.pty_mode:
            cmd.json_stream = False
        cmd.resume = bool(process.session_id and self._has_session(process))
        return cmd

    def restart_snapshot(
        self,
        process: "AgenticProcess",
        options: AgentOptions,
    ) -> dict:
        return restart_payload_from_cli_options(options)

    # ------------------------------------------------------------------
    # Process hooks
    # ------------------------------------------------------------------

    supports_process_hooks = True
    process_hooks_use_assets = True

    def hook_capabilities(self) -> "HookCapabilities":
        return dict(_HOOK_CAPABILITIES)

    def process_hook_snapshot(self, events: "Sequence[HookEventType]") -> dict:
        return build_process_hook_snapshot(events, provider=self.name)

    def prepare_process_hooks(
        self,
        assets: "AssetDir",
        process_id: str,
        events: "Sequence[HookEventType]",
    ) -> ProcessHookRuntime:
        """Materialize the plugin; return an EMPTY runtime.

        Unlike every other vendor there is nothing to add to the command line —
        opencode has no plugin flag. The generated plugin reaches the worker
        because ``config_for_assets_dir`` finds it in this same assets dir and
        lists it in the ``opencode.json`` that ``OPENCODE_CONFIG`` points at.
        """
        normalized = normalize_process_hook_events(events, provider=self.name)
        # The shared normalizer validates against the V1 three-event set, which
        # is WIDER than what opencode declares (no SessionEnd). Re-check against
        # our own capability so a stale row can never render a plugin with a
        # handler opencode would never call.
        declared = _HOOK_CAPABILITIES[HookScope.PROCESS].events
        unsupported = sorted(e.value for e in normalized if e not in declared)
        if unsupported:
            raise ValueError(f"Unsupported Opencode process hook event: {', '.join(unsupported)}")
        if not normalized:
            assets.remove(PLUGIN_SUBDIR)
            return ProcessHookRuntime()
        if not is_valid_entity_id(process_id):
            raise ValueError(f"Invalid agentic process id: {process_id!r}")

        command, prefix_args = get_installed_flow_invocation()
        source = render_plugin(
            process_id=process_id,
            flow_argv=[command, *prefix_args],
            events=tuple(normalized),
        )
        assets.remove(PLUGIN_SUBDIR)
        assets.load_asset(str(plugin_path(Path("."))), content=source)
        return ProcessHookRuntime()

    # ── Per-process MCP ──────────────────────────────────────────────────
    supports_process_mcp = True

    def prepare_process_mcp(self, specs: "Sequence[McpSpec]") -> ProcessMcpRuntime:
        """The ``mcp`` key of the generated per-process config.

        The only vendor with a genuinely different shape — ``command`` is an
        array, the env key is ``environment``, and the discriminator is
        ``local``/``remote``.
        """
        if not specs:
            return ProcessMcpRuntime()
        return ProcessMcpRuntime(config_fragment=to_opencode_mcp(specs))

    def normalize_process_hook_data(
        self,
        process_id: str,
        raw_hook_data: dict,
    ) -> "AgentHookData":
        if not is_valid_entity_id(process_id):
            raise ValueError(f"Invalid agentic process id: {process_id!r}")
        raw = dict(raw_hook_data)
        supported = {event.value for event in _HOOK_CAPABILITIES[HookScope.PROCESS].events}
        event = raw.get("hook_event_name")
        if event not in supported:
            raise ValueError(f"Unsupported Opencode process hook event: {event!r}")
        hook_data: dict = {"hook_event_name": event}
        for key in ("prompt", "cwd", "session_id", "timestamp"):
            if key in raw:
                hook_data[key] = raw[key]
        hook_data["raw_hook_data"] = raw
        return AgentHookData(agentic_process_id=process_id, hook_data=hook_data)

    # ------------------------------------------------------------------
    # Per-turn execution
    # ------------------------------------------------------------------

    async def headless_prompt(
        self,
        process: "AgenticProcess",
        instruction: str,
    ) -> "ApiResponse":
        try:
            await process.get_project()
        except Exception:
            logger.debug("OpenCodeDriver.headless_prompt: get_project failed", exc_info=True)
        instruction_assets = await process.prepare_system_instruction_assets()
        if not process.workdir:
            return ApiFailResponse(message="opencode prompt: workdir is not set")

        # Resume ONLY when opencode actually has this session; an unknown id is
        # a hard error from the CLI, not a silent fresh start.
        resumable = self.has_resumable_session(process)

        full_prompt = self.compose_prompt(instruction, process.get_agents_json())
        cli_cfg = process.cli_config or {}
        env_vars = apply_worker_env(dict(cli_cfg.get("env_vars") or {}), process)
        await apply_worker_secret_env(env_vars, process)

        config_path = self._write_config(process, instruction_assets)

        context = AgenticContext(
            workdir=process.workdir,
            env_vars=env_vars,
            model=cli_cfg.get("model"),
            permission_mode=cli_cfg.get("permission_mode", "bypassPermissions"),
            add_dirs=list(process.resolved_add_dirs or []),
            session_id=None,  # opencode mints its own
            resume_session_id=process.session_id if resumable else None,
            # The generated config is opencode's ONLY instruction channel: it
            # has no --add-dir, so the assets dir alone would never be read.
            custom_instruction_dirs=[str(config_path)] if config_path else [],
        )
        from flow_sdk.builtin.agentic_process.cli_drivers import api_auth  # noqa: PLC0415

        await api_auth.stamp_api_model(context, process)

        worker = OpenCodeCLIStreamWorker.for_process(process.id)
        return await run_headless_turn(
            self, process, worker, prompt=full_prompt, context=context, logger=logger
        )

    def stream_worker(self, process: "AgenticProcess") -> OpenCodeCLIStreamWorker:
        return OpenCodeCLIStreamWorker.for_process(process.id)

    # ------------------------------------------------------------------
    # Auth
    # ------------------------------------------------------------------

    async def auth_probe(self) -> WorkerAuthResult:
        """``opencode providers list`` answers non-interactively and exits 0,
        so unlike copilot this probe can report a vendor-confirmed state."""
        return await run_worker_auth_probe(self.name)

    # OpenCode's login is an interactive provider picker rather than an
    # RFC-8628 device flow; the API-key path (a provider key in the environment)
    # is the supported headless route.
    device_login_spec = DeviceLoginSpec(
        login_argv=("opencode", "providers", "login"),
        url_re=re.compile(r"(https://\S+)"),
        code_re=None,
        accepts_code_paste=False,
    )

    # ------------------------------------------------------------------
    # Transcript discovery
    # ------------------------------------------------------------------

    def transcript_descriptor(self, process: "AgenticProcess") -> TranscriptDescriptor | None:
        """Resolve the OpenCode transcript for READING.

        Preference is the INVERSE of copilot's, and deliberately so. Copilot
        prefers its vendor session record because that record is complete while
        the stdout tee lacks the user message. Here the tee is the richer of the
        two for a headless turn — the worker writes the user prompt into it —
        and the vendor store is a SQLite database with nothing tail-readable, so
        it is used only through a projection, for PTY sessions that never had a
        tee at all.
        """
        local = self._process_local_descriptor(process)
        if local is not None:
            return local
        return self._session_descriptor(process)

    def transcript_path(self, process: "AgenticProcess") -> Path | None:
        descriptor = self.transcript_descriptor(process)
        return descriptor.path if descriptor else None

    def skills_root(self, process: "AgenticProcess", assets_dir: Path) -> Path:
        """OpenCode discovers skills from any dir listed in ``skills.paths``.

        There is no ``--add-dir``, so the generated per-process config registers
        this path — which makes opencode skills process-isolated, unlike codex's
        single global ``$CODEX_HOME/skills``.
        """
        return assets_dir / SKILLS_SUBDIR

    def tail_status(self, transcript_path: Path) -> WorkerStatus:
        return opencode_tail_status(transcript_path)

    def has_resumable_session(self, process: "AgenticProcess") -> bool:
        return self._has_session(process)

    def supports_plan_mode(self, process: "AgenticProcess") -> bool:
        # OpenCode ships a built-in ``plan`` agent, but FlowPad's plan flow also
        # needs the ExitPlanMode tool contract to surface ``plan_path``, which
        # opencode does not emit. Kept False until that is wired.
        return False

    # ------------------------------------------------------------------
    # History materialisation
    # ------------------------------------------------------------------

    def load_history(self, process: "AgenticProcess") -> list["FlowData"]:
        descriptor = self.transcript_descriptor(process)
        if descriptor is not None:
            return _opencode_load_transcript_history(
                descriptor.path,
                transcript_format=descriptor.format,
            )
        return _opencode_load_session_history(process.session_id or "", process_id=process.id)

    def compose_prompt(self, instruction: str, agents_json: dict | None) -> str:
        return instruction

    def external_session_dirs(self) -> set[str]:
        return external_session_ids()

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _write_config(self, process: "AgenticProcess", instruction_assets) -> Path | None:
        """Generate the per-process ``opencode.json`` (instructions + skills + MCP).

        ``instruction_assets`` may be None — a process with only mounted roots
        or attached servers still needs a config, and the generator returns None
        when there is genuinely nothing to say.
        """
        return config_for_assets_dir(
            process.id,
            getattr(instruction_assets, "assets_dir", None),
            dict(self.prepare_process_mcp(process.resolved_mcp_servers()).config_fragment),
            list(process.resolved_add_dirs or []),
        )

    def _process_local_descriptor(self, process: "AgenticProcess") -> TranscriptDescriptor | None:
        path = opencode_transcript_path_for_process(process.id)
        try:
            if not path.exists() or path.stat().st_size == 0:
                return None
        except OSError:
            return None
        return TranscriptDescriptor(
            path=path,
            format=TranscriptFormat.OPENCODE_STREAM,
            source=TranscriptSource.PROCESS_LOCAL,
            session_id=process.session_id or "",
        )

    def _session_descriptor(self, process: "AgenticProcess") -> TranscriptDescriptor | None:
        # ``process.session_id`` is NOT authoritative here. Opening a process
        # stamps a FlowPad uuid on it before any worker runs, and opencode mints
        # its own ``ses_…`` id — so for an interactive session the recorded id is
        # a uuid the store has never heard of. Fall back to the newest session
        # for this cwd whenever the recorded id projects to nothing; the caller
        # persists the descriptor's id, so the process self-heals onto the real
        # one after the first resolve. (Same shape as codex's rollout lookup.)
        path = None
        session_id = process.session_id or ""
        if session_id:
            path = assemble_session_jsonl(session_id, process.id)
        if path is None or not path.exists():
            # BOUNDED by this worker's own start instant. A directory accumulates
            # sessions across runs, so an unbounded "newest for this cwd" makes a
            # freshly-launched process adopt the PREVIOUS run's conversation and
            # replay it into the pane. Codex bounds its rollout scan the same way.
            since = self._worker_started_ms(process)
            if since is None:
                return None
            session_id = find_latest_opencode_session(cwd=process.workdir, since_ms=since) or ""
            path = assemble_session_jsonl(session_id, process.id) if session_id else None
        if path is None or not path.exists():
            return None
        return TranscriptDescriptor(
            path=path,
            format=TranscriptFormat.OPENCODE_SESSION,
            source=TranscriptSource.WORKER_SESSION,
            session_id=session_id,
            # Materialised from the SQLite store — only ``assemble_session_jsonl``
            # ever grows it, so a live poller has to come back through here.
            derived=True,
        )

    @staticmethod
    def _worker_started_ms(process: "AgenticProcess") -> int | None:
        """This worker's launch instant as epoch-ms, or None if it never started.

        None is the honest answer for a process with no live worker: the store
        cannot hold a session it owns, so resolution must return nothing rather
        than fall back to whatever the directory saw last.
        """
        value = (process.context_data or {}).get(AgenticProcessContextKey.WORKER_STARTED_AT.value)
        if not value:
            return None
        try:
            stamp = datetime.fromisoformat(str(value))
        except ValueError:
            return None
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=timezone.utc)
        return int(stamp.timestamp() * 1000)

    def _has_session(self, process: "AgenticProcess") -> bool:
        """Can ``--session <process.session_id>`` actually be handed to opencode?

        The VENDOR STORE is the only authority, and there is deliberately no
        process-local-tee fallback here (copilot has one; opencode must not).
        The difference is that copilot accepts a caller-supplied ``--session-id``
        on a fresh start, so any id FlowPad minted is resumable by construction;
        opencode does not — ``--session`` only ever CONTINUES, and an id it has
        never seen exits 1 with "Session not found" before any model call.

        That distinction bites because ``_perform_open`` stamps
        ``self.session_id = self.session_id or str(uuid4())`` unconditionally,
        without consulting ``preassign_interactive_session_id``. So an opencode
        PTY process carries a uuid the vendor cannot know, while its headless
        turns leave a non-empty tee — and a tee-based fallback would read that
        pair as "resumable" and emit ``opencode --auto --session <uuid>``, which
        cannot start. Gating on the store keeps the uuid case a fresh launch
        (opencode then mints its own ``ses_…``), and still resumes correctly
        once a real turn has adopted that vendor id.
        """
        if not process.session_id:
            return False
        return bool(find_opencode_session(process.session_id))


#: The class ``get_driver`` instantiates for this vendor (looked up by ``VENDORS[...].package``).
DRIVER = OpenCodeDriver
