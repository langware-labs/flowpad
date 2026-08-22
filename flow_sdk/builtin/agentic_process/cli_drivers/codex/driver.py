"""OpenAI Codex WorkerDriver — vendor glue for the AgenticProcess driver layer.

Concentrates everything previously expressed as ``if worker_type == CODEX`` in
``AgenticProcess`` so the entity stays vendor-pure: cli_options building,
headless ``codex exec --json`` turn execution, transcript location (process-
local file the worker tee'd), tail-status mapping, history loading, and the
prompt-composition compatibility hook.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import TYPE_CHECKING, Any, Sequence

from flow_sdk.api.api_types.identifier import is_valid_entity_id
from flow_sdk.builtin.agent_hook import HookEventType
from flow_sdk.builtin.agentic_process.asset_dir import AssetDir
from flow_sdk.builtin.agentic_process.cli_drivers.cli_serialization import (
    render_shell_command,
)
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    AgenticContext,
    AgenticProcessContextKey,
    AgentOptions,
    DeviceLoginSpec,
    ProcessHookRuntime,
    WorkerAuthResult,
    apply_worker_env,
    apply_worker_secret_env,
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
from flow_sdk.builtin.agentic_process.cli_drivers.headless_turn import run_headless_turn
from flow_sdk.builtin.agentic_process.process_hooks import (
    SUPPORTED_PROCESS_HOOK_EVENTS,
    build_canonical_hook_data,
    build_process_hook_snapshot,
    normalize_process_hook_events,
)
from flow_sdk.builtin.flowpad_runner_wrapper import get_installed_flow_invocation
from flow_sdk.builtin.hooks.capabilities import process_capability, unsupported
from flow_sdk.builtin.hooks.types import HookCapabilities, HookScope
from flow_sdk.builtin.worker_status import WorkerStatus
from flow_sdk.core.flow.models.webhook_flow_data import AgentHookData
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.responses.response import ApiFailResponse
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

# Codex surfaces turn/permission/model context the other vendors do not.
_CANONICAL_FIELDS = (
    "hook_event_name",
    "prompt",
    "session_id",
    "cwd",
    "transcript_path",
    "turn_id",
    "permission_mode",
    "model",
    "source",
    "reason",
)


#: Codex reads ``hooks.<Event>`` from config.toml (User/Project — added by the
#: config writer) and accepts the same table as ``-c`` launch overrides
#: (Process). Only the launch route is wired today.
#: Verified against codex-cli 0.147.0: ``hooks.<Event>`` IS a real config.toml
#: key and a ``[hooks]`` table parses clean, but a file-declared hook is
#: SILENTLY SKIPPED unless its trust is persisted — measured directly: the same
#: hook fires with ``--dangerously-bypass-hook-trust`` and does nothing without
#: it. Only the interactive TUI writes that trust record (``hooks.state``), and
#: forging one on the user's behalf would defeat a deliberate vendor safety
#: gate. A hook we launch carries the bypass flag; a run we did NOT launch
#: cannot — which is exactly what global scope has to serve. So global stays
#: unsupported until trust can be granted honestly.
_TRUST_GATE = (
    "codex silently skips a config.toml hook whose trust is not persisted, and only "
    "its interactive TUI can grant that trust"
)

_HOOK_CAPABILITIES: "HookCapabilities" = {
    HookScope.USER: unsupported(_TRUST_GATE),
    HookScope.PROJECT: unsupported(_TRUST_GATE),
    HookScope.PROCESS: process_capability(),
}

class CodexDriver:
    """Vendor glue for OpenAI Codex. Implements the ``WorkerDriver`` Protocol."""

    name = WorkerType.CODEX.value
    supports_process_hooks = True
    process_hooks_use_assets = False
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
        embedded sub-agent names as ``skill_names`` so ``cmd_line`` reflects them
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
            return ProcessHookRuntime()
        if not is_valid_entity_id(process_id):
            raise ValueError(f"Invalid agentic process id: {process_id!r}")

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
            "command": render_shell_command(flow_argv, "linux"),
            "commandWindows": render_shell_command(flow_argv, "win32"),
        }
        # Codex names its events exactly as we do, and ``hooks`` is a TOML
        # table with one key per event.
        return ProcessHookRuntime(
            config_overrides=(
                ("features.hooks", True),
                *(
                    (
                        f"hooks.{event.value}",
                        [{"hooks": [handler]}],
                    )
                    for event in normalized
                ),
            ),
            bypass_hook_trust=True,
        )

    def normalize_process_hook_data(
        self,
        process_id: str,
        raw_hook_data: dict[str, Any],
    ) -> AgentHookData:
        event = raw_hook_data.get("hook_event_name")
        if event not in SUPPORTED_PROCESS_HOOK_EVENTS:
            raise ValueError(f"Unsupported Codex process hook event: {event!r}")
        return build_canonical_hook_data(process_id, raw_hook_data, fields=_CANONICAL_FIELDS)

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
        process_assets = await process.prepare_process_assets()
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
            **process._process_asset_context_kwargs(process_assets),
        )

        worker = CodexCLIStreamWorker.for_process(process.id)
        return await run_headless_turn(
            self, process, worker, prompt=full_prompt, context=context, logger=logger
        )

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
