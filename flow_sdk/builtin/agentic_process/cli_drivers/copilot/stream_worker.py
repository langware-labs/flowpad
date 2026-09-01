"""CopilotCLIStreamWorker — non-interactive GitHub Copilot CLI JSON streaming."""

from __future__ import annotations

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    AgenticContext,
    build_worker_spawn_env,
    resolve_worker_argv0,
)
from flow_sdk.builtin.agentic_process.cli_drivers.copilot.cli import CopilotAgentOptions
from flow_sdk.builtin.agentic_process.cli_drivers.copilot.event_to_flowdata import (
    CopilotEventConverter,
    final_end_frame,
)
from flow_sdk.builtin.agentic_process.cli_drivers.copilot.session_history import (
    copilot_transcript_path_for_process,
)
from flow_sdk.builtin.agentic_process.cli_drivers.jsonl_tee_worker import JsonlTeeStreamWorker
from flow_sdk.builtin.agentic_process.cli_drivers.transcript_durability_gate import TranscriptDurabilityGate
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData

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


class CopilotCLIStreamWorker(JsonlTeeStreamWorker):
    """Runs one Copilot CLI turn and streams stdout JSONL as FlowData."""

    vendor = "copilot"
    session_key = "sessionId"
    session_id_parents = ("result", "data")
    terminal_types = frozenset({"result", "flowpad.interrupted", "flowpad.error"})
    prompt_on_stdin = True
    converter_cls = CopilotEventConverter
    gate_cls = _TranscriptDurabilityGate

    @classmethod
    def for_process(cls, process_id: str) -> "CopilotCLIStreamWorker":
        return cls(transcript_path=copilot_transcript_path_for_process(process_id))

    @property
    def cancel_grace_seconds(self) -> float:
        return CANCEL_GRACE_SECONDS

    def _end_frame(self) -> FlowData:
        return final_end_frame()

    def _build_spawn(
        self,
        context: AgenticContext,
        prompt: str,
    ) -> tuple[list[str], dict[str, str], str | None]:
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
        # Launch-only, so stamped rather than passed — the headless path must
        # carry the same per-process MCP the PTY path does.
        opts.mcp_config_json = context.mcp_config_json
        # Asset-backed system instructions ride COPILOT_CUSTOM_INSTRUCTIONS_DIRS;
        # the legacy system_prompt_append path remains unused for new launches.
        argv, env_from_opts, stdin = opts.to_spawn(instruction=prompt, system_prompt_append=context.instructions)
        # Context env_vars win (except the discovered capability bin folder
        # stays first on PATH); argv[0] is pinned to the discovered absolute
        # executable so a stripped backend service PATH can't break the spawn.
        env = build_worker_spawn_env("copilot", env_from_opts)
        argv = resolve_worker_argv0("copilot", argv, env)
        return argv, env, stdin
