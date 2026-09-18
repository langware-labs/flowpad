"""DeepAgentsCLIStreamWorker — one headless turn of the Deep Agents runner, streamed as FlowData."""

from __future__ import annotations

from typing import Any

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    AgenticContext,
    WorkerSpawnError,
    build_worker_spawn_env,
)
from flow_sdk.builtin.agentic_process.cli_drivers.deepagents.cli import DeepAgentsAgentOptions
from flow_sdk.builtin.agentic_process.cli_drivers.deepagents.event_to_flowdata import (
    DeepAgentsEventConverter,
)
from flow_sdk.builtin.agentic_process.cli_drivers.deepagents.runner import SUPPORTED_PERMISSION_MODES
from flow_sdk.builtin.agentic_process.cli_drivers.deepagents.session_history import (
    deepagents_transcript_path_for_process,
)
from flow_sdk.builtin.agentic_process.cli_drivers.jsonl_tee_worker import JsonlTeeStreamWorker
from flow_sdk.builtin.agentic_process.cli_drivers.replay_envelope import final_end_frame
from flow_sdk.builtin.agentic_process.cli_drivers.transcript_durability_gate import TranscriptDurabilityGate
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData

CANCEL_GRACE_SECONDS = 5.0

# Events that prove the turn is CONTINUING past a held terminal candidate.
_CONTINUATION_EVENTS = frozenset({"text", "reasoning", "tool_call", "tool_result"})


class _TranscriptDurabilityGate(TranscriptDurabilityGate):
    """The shared ordering gate, told this vendor's two facts."""

    def is_terminal_candidate(self, event: dict, frames: list[FlowData]) -> bool:
        # The MAIN agent's text may be the answer; a subagent's never ends the turn.
        return event.get("type") == "text" and event.get("agent") is None

    def is_continuation(self, event_type: str) -> bool:
        return event_type in _CONTINUATION_EVENTS


class DeepAgentsCLIStreamWorker(JsonlTeeStreamWorker):
    """Runs one runner turn and streams its stdout JSONL as FlowData."""

    vendor = "deepagents"
    session_key = "session_id"
    session_id_parents = ()
    terminal_types = frozenset({"result", "flowpad.interrupted", "flowpad.error"})
    prompt_on_stdin = True
    converter_cls = DeepAgentsEventConverter
    gate_cls = _TranscriptDurabilityGate

    def __init__(self, *args: Any, agents_json: dict | None = None, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._agents_json = dict(agents_json or {})

    @classmethod
    def for_process(cls, process_id: str, agents_json: dict | None = None) -> "DeepAgentsCLIStreamWorker":
        return cls(
            transcript_path=deepagents_transcript_path_for_process(process_id),
            process_id=process_id,
            agents_json=agents_json,
        )

    @property
    def cancel_grace_seconds(self) -> float:
        return CANCEL_GRACE_SECONDS

    def _end_frame(self) -> FlowData:
        return final_end_frame()

    def _terminal_synthetic_event(self) -> dict[str, Any] | None:
        synthetic = super()._terminal_synthetic_event()
        if synthetic is not None:
            return synthetic
        # A clean exit that printed no ``result`` still ended the turn; close it so
        # ``tail_status`` reaches COMPLETE instead of hanging on the last line.
        if self._proc and self._proc.returncode == 0:
            return {
                "type": "result",
                "session_id": self._session_id,
                "subtype": "success",
                "is_error": False,
                "reason": "synthetic-terminal",
            }
        return None

    def _build_spawn(
        self,
        context: AgenticContext,
        prompt: str,
    ) -> tuple[list[str], dict[str, str], str | None]:
        opts = DeepAgentsAgentOptions(
            workdir=context.workdir,
            env_vars=dict(context.env_vars) if context.env_vars else None,
            model=context.model,
            permission_mode=context.permission_mode,
            # The session id is OURS (a LangGraph thread id), so a fresh turn and a resumed one
            # spell it the same way; the runner resumes when it has checkpointed the thread.
            session_id=self._session_id or context.resume_session_id or context.session_id,
            add_dirs=list(context.add_dirs or []),
        )
        if opts.permission_mode not in SUPPORTED_PERMISSION_MODES:
            raise WorkerSpawnError(
                self.vendor,
                f"permission mode {context.permission_mode!r} is not supported by the deepagents worker: "
                "its shell tool sits outside the harness's permission model, so only bypassPermissions is honest",
            )
        opts.system_prompt_file = context.system_prompt_file
        opts.mcp_config_fragment = dict(context.mcp_config_fragment or {})
        opts.agents_json = self._agents_json
        for directory in context.custom_instruction_dirs or []:
            if directory not in opts.add_dirs:
                opts.add_dirs.append(directory)
        argv, env_from_opts, stdin = opts.to_spawn(instruction=prompt, system_prompt_append=context.instructions)
        # The install gate: raises WorkerSpawnError when the harness package is not importable.
        env = build_worker_spawn_env(self.vendor, env_from_opts)
        return argv, env, stdin
