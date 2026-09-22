"""Deep Agents WorkerDriver.

Headless-only, hidden from every picker, funded only by an LLM endpoint. What it does not
support it DECLARES (no process hooks, no plan mode, no fork, no device login, no interactive
TUI) — see ``worker_spec/AgenticWorkerSpec.md`` §0 "Declaring a capability unsupported".
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from pathlib import Path
from typing import TYPE_CHECKING

from flow_sdk.api.api_types.identifier import is_valid_entity_id
from flow_sdk.builtin.agentic_process.cli_drivers.auth_probe import WorkerAuthStatus
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    AgenticContext,
    AgentOptions,
    ProcessHookRuntime,
    ProcessMcpRuntime,
    WorkerAuthResult,
    apply_worker_env,
    apply_worker_secret_env,
    restart_payload_from_cli_options,
    worker_bin_folder,
)
from flow_sdk.builtin.agentic_process.cli_drivers.deepagents.cli import (
    SKILLS_SUBDIR,
    DeepAgentsAgentOptions,
)
from flow_sdk.builtin.agentic_process.cli_drivers.deepagents.session_history import (
    deepagents_transcript_path_for_process,
    external_session_ids,
    find_deepagents_session,
)
from flow_sdk.builtin.agentic_process.cli_drivers.deepagents.session_history import (
    load_session_history as _load_session_history,
)
from flow_sdk.builtin.agentic_process.cli_drivers.deepagents.session_history import (
    load_transcript_history as _load_transcript_history,
)
from flow_sdk.builtin.agentic_process.cli_drivers.deepagents.status import deepagents_tail_status
from flow_sdk.builtin.agentic_process.cli_drivers.deepagents.stream_worker import (
    DeepAgentsCLIStreamWorker,
)
from flow_sdk.builtin.agentic_process.cli_drivers.headless_turn import run_headless_turn
from flow_sdk.builtin.agentic_process.cli_drivers.mcp_projection import to_mcp_servers_json
from flow_sdk.flowpad_types.vendors import vendor_for
from flow_sdk.responses.response import ApiFailResponse
from flow_sdk.transcript_analyzer import (
    TranscriptDescriptor,
    TranscriptFormat,
    TranscriptSource,
)
from flow_sdk.transcript_analyzer.worker_status import WorkerStatus

VENDOR = vendor_for("deepagents")

if TYPE_CHECKING:
    from flow_sdk.assets.directory import AssetDir
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.builtin.hooks.types import HookCapabilities, HookEventType
    from flow_sdk.core.flow.models.webhook_flow_data import AgentHookData
    from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData
    from flow_sdk.responses.response import ApiResponse
    from flow_sdk.schema.data_spec.mcp_spec import McpSpec

logger = logging.getLogger(__name__)


class DeepAgentsDriver:
    """Vendor glue for the Deep Agents runner."""

    name = VENDOR.key

    # The session id is a LangGraph thread id — OURS to mint, so it is assigned before the first
    # turn and a fresh turn and a resumed one spell it the same way (no adoption dance).
    preassign_interactive_session_id = True

    # No TUI (``Vendor.interactive`` is False); the PTY facts are inert defaults.
    pty_submits_on_paste = False
    pty_composer_ready_pattern = None
    pins_resume_cwd = False

    def prepare_instruction_assets(self, assets: "AssetDir", instructions: str) -> "Path | None":
        from flow_sdk.assets.instruction_projection import project_instructions

        return project_instructions(assets, instructions, discovery_file="AGENTS.md")

    # ------------------------------------------------------------------
    # CLI shape
    # ------------------------------------------------------------------

    def cli_options(self, process: "AgenticProcess") -> DeepAgentsAgentOptions:
        cmd = DeepAgentsAgentOptions.from_json(process.cli_config)
        cmd.session_id = process.session_id
        cmd.workdir = process.workdir
        cmd.add_dirs = process.resolved_add_dirs
        agents_json = process.get_agents_json()
        if agents_json:
            cmd.agents_json = agents_json
        return cmd

    def restart_snapshot(self, process: "AgenticProcess", options: AgentOptions) -> dict:
        return restart_payload_from_cli_options(options)

    # ------------------------------------------------------------------
    # Process hooks — declared unsupported
    # ------------------------------------------------------------------

    supports_process_hooks = False
    process_hooks_use_assets = False

    def hook_capabilities(self) -> "HookCapabilities":
        return {}

    def process_hook_snapshot(self, events: "Sequence[HookEventType]") -> dict:
        if events:
            raise NotImplementedError("the deepagents worker has no process hook channel")
        return {}

    def prepare_process_hooks(
        self,
        assets: "AssetDir",
        process_id: str,
        events: "Sequence[HookEventType]",
    ) -> ProcessHookRuntime:
        if events:
            raise NotImplementedError("the deepagents worker has no process hook channel")
        return ProcessHookRuntime()

    def normalize_process_hook_data(self, process_id: str, raw_hook_data: dict) -> "AgentHookData":
        raise NotImplementedError("the deepagents worker has no process hook channel")

    # ── Per-process MCP ──────────────────────────────────────────────────
    supports_process_mcp = True

    def prepare_process_mcp(self, specs: "Sequence[McpSpec]") -> ProcessMcpRuntime:
        """The ``mcpServers`` body, handed to the runner inline (``--mcp-config``)."""
        if not specs:
            return ProcessMcpRuntime()
        return ProcessMcpRuntime(config_fragment=to_mcp_servers_json(specs))

    # ------------------------------------------------------------------
    # Per-turn execution
    # ------------------------------------------------------------------

    async def headless_prompt(self, process: "AgenticProcess", instruction: str) -> "ApiResponse":
        try:
            await process.get_project()
        except Exception:
            logger.debug("DeepAgentsDriver.headless_prompt: get_project failed", exc_info=True)
        instruction_assets = await process.prepare_system_instruction_assets()
        if not process.workdir:
            return ApiFailResponse(message="deepagents prompt: workdir is not set")

        resumable = self.has_resumable_session(process)
        if not process.session_id:
            from flow_sdk.api.api_types.identifier import mint_uuid  # noqa: PLC0415

            process.session_id = mint_uuid()

        cli_cfg = process.cli_config or {}
        env_vars = apply_worker_env(dict(cli_cfg.get("env_vars") or {}), process)
        await apply_worker_secret_env(env_vars, process)

        context = AgenticContext(
            workdir=process.workdir,
            env_vars=env_vars,
            model=cli_cfg.get("model"),
            permission_mode=cli_cfg.get("permission_mode", "bypassPermissions"),
            add_dirs=list(process.resolved_add_dirs or []),
            session_id=None if resumable else process.session_id,
            resume_session_id=process.session_id if resumable else None,
            system_prompt_file=getattr(instruction_assets, "system_prompt_file", None),
            custom_instruction_dirs=(
                [str(instruction_assets.assets_dir)] if getattr(instruction_assets, "assets_dir", None) else []
            ),
            mcp_config_fragment=dict(self.prepare_process_mcp(process.resolved_mcp_servers()).config_fragment),
        )
        from flow_sdk.builtin.agentic_process.cli_drivers import api_auth  # noqa: PLC0415

        await api_auth.stamp_api_model(context, process)

        full_prompt = self.compose_prompt(instruction, process.get_agents_json())
        return await run_headless_turn(
            self, process, self.stream_worker(process), prompt=full_prompt, context=context, logger=logger
        )

    def stream_worker(self, process: "AgenticProcess") -> DeepAgentsCLIStreamWorker:
        return DeepAgentsCLIStreamWorker.for_process(process.id, agents_json=process.get_agents_json())

    # ------------------------------------------------------------------
    # Auth — there is no vendor account; the worker is funded by an LLM endpoint
    # ------------------------------------------------------------------

    async def auth_probe(self) -> WorkerAuthResult:
        if worker_bin_folder(self.name) is None:
            return WorkerAuthResult(status=WorkerAuthStatus.NOT_INSTALLED, message="the deepagents package is not installed")
        return WorkerAuthResult(
            status=WorkerAuthStatus.UNKNOWN,
            message="Deep Agents has no account of its own: it is funded by an LLM endpoint or a stored provider key.",
            auth_mode="api",
        )

    device_login_spec = None

    # ------------------------------------------------------------------
    # Transcript discovery
    # ------------------------------------------------------------------

    @property
    def session_store_env(self) -> dict[str, str]:
        return {}

    @property
    def naming_adapter(self):
        from flow_sdk.builtin.agentic_process.naming.providers import DeepAgentsNamingAdapter

        return DeepAgentsNamingAdapter()

    def transcript_descriptor(self, process: "AgenticProcess") -> TranscriptDescriptor | None:
        """The runner's stdout tee — the only transcript there is, and a complete one (it carries
        the user's own turn and a terminal ``result``)."""
        path = deepagents_transcript_path_for_process(process.id)
        try:
            if not path.exists() or path.stat().st_size == 0:
                return None
        except OSError:
            return None
        return TranscriptDescriptor(
            path=path,
            format=TranscriptFormat.DEEPAGENTS_STREAM,
            source=TranscriptSource.PROCESS_LOCAL,
            session_id=process.session_id or "",
        )

    def transcript_path(self, process: "AgenticProcess") -> Path | None:
        descriptor = self.transcript_descriptor(process)
        return descriptor.path if descriptor else None

    async def available_assets(self, process: "AgenticProcess"):
        from flow_sdk.builtin.agentic_process.cli_drivers.deepagents.asset_inventory import available_assets

        return await available_assets(self.cli_options(process))

    def asset_search_roots(self, process: "AgenticProcess"):
        from flow_sdk.assets.asset_discovery import AssetSearchRoot
        from flow_sdk.schema.types import EntityType

        directories = [*(process.resolved_add_dirs or []), *([process.workdir] if process.workdir else [])]
        return [
            AssetSearchRoot(asset_type=EntityType.SKILL, path=Path(directory) / SKILLS_SUBDIR, recursive=True)
            for directory in directories
        ]

    def skills_root(self, process: "AgenticProcess", assets_dir: Path) -> Path:
        """Process-isolated, like opencode's: the runner is handed this dir as a skills source."""
        return assets_dir / SKILLS_SUBDIR

    def tail_status(self, transcript_path: Path) -> WorkerStatus:
        return deepagents_tail_status(transcript_path)

    def has_resumable_session(self, process: "AgenticProcess") -> bool:
        return self._has_session(process)

    def supports_plan_mode(self, process: "AgenticProcess") -> bool:
        return False

    # ------------------------------------------------------------------
    # History materialisation
    # ------------------------------------------------------------------

    def load_history(self, process: "AgenticProcess") -> list["FlowData"]:
        descriptor = self.transcript_descriptor(process)
        if descriptor is not None:
            return _load_transcript_history(descriptor.path, transcript_format=descriptor.format)
        return _load_session_history(process.session_id or "", process_id=process.id)

    def compose_prompt(self, instruction: str, agents_json: dict | None) -> str:
        return instruction

    def external_session_dirs(self) -> set[str]:
        return external_session_ids()

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _has_session(self, process: "AgenticProcess") -> bool:
        """The checkpoint store is the only authority: a preassigned id with no checkpoint yet
        is a FRESH turn, not a resume."""
        session_id = process.session_id or ""
        return bool(session_id and is_valid_entity_id(session_id) and find_deepagents_session(session_id))


#: The class ``get_driver`` instantiates for this vendor (looked up by ``VENDORS[...].package``).
DRIVER = DeepAgentsDriver
