"""OpenCodeCLIStreamWorker — non-interactive OpenCode CLI JSON streaming."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    AgenticContext,
    build_worker_spawn_env,
    resolve_worker_argv0,
)
from flow_sdk.builtin.agentic_process.cli_drivers.jsonl_tee_worker import JsonlTeeStreamWorker
from flow_sdk.builtin.agentic_process.cli_drivers.opencode.cli import OpenCodeAgentOptions
from flow_sdk.builtin.agentic_process.cli_drivers.opencode.event_to_flowdata import (
    OpenCodeEventConverter,
    final_end_frame,
)
from flow_sdk.builtin.agentic_process.cli_drivers.opencode.session_history import (
    opencode_transcript_path_for_process,
)
from flow_sdk.builtin.agentic_process.cli_drivers.transcript_durability_gate import TranscriptDurabilityGate
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData

CANCEL_GRACE_SECONDS = 5.0

# Events that prove the turn is CONTINUING past a held terminal candidate.
_CONTINUATION_EVENTS = frozenset({"step_start", "text", "reasoning", "tool_use"})


def _is_stop(event: dict) -> bool:
    """``step_finish`` with ``part.reason == "stop"`` — OpenCode's terminal; the
    same event with ``reason == "tool-calls"`` means the tool loop continues."""
    if event.get("type") != "step_finish":
        return False
    part = event.get("part") if isinstance(event.get("part"), dict) else {}
    return part.get("reason") == "stop"


class _TranscriptDurabilityGate(TranscriptDurabilityGate):
    """The shared ordering gate, told what OpenCode's two vendor facts are."""

    def is_terminal_candidate(self, event: dict, frames: list[FlowData]) -> bool:
        return _is_stop(event)

    def is_continuation(self, event_type: str) -> bool:
        return event_type in _CONTINUATION_EVENTS


class OpenCodeCLIStreamWorker(JsonlTeeStreamWorker):
    """Runs one OpenCode CLI turn and streams stdout JSONL as FlowData."""

    vendor = "opencode"
    session_key = "sessionID"
    session_id_parents = ("part",)
    terminal_types = frozenset({"flowpad.interrupted", "flowpad.error", "flowpad.result"})
    prompt_on_stdin = False  # the prompt rides argv; stdin is /dev/null
    converter_cls = OpenCodeEventConverter
    gate_cls = _TranscriptDurabilityGate
    #: The concrete model slug the tier resolved to — stashed by ``_build_spawn``
    #: so the transcript can record which model produced the turn.
    _resolved_model: str | None = None

    @classmethod
    def for_process(cls, process_id: str) -> "OpenCodeCLIStreamWorker":
        # ``process_id`` is needed to generate the per-process config when the
        # caller hands over the raw assets dir — see ``_config_path_from_context``.
        return cls(transcript_path=opencode_transcript_path_for_process(process_id), process_id=process_id)

    @property
    def cancel_grace_seconds(self) -> float:
        return CANCEL_GRACE_SECONDS

    def _end_frame(self) -> FlowData:
        return final_end_frame()

    def _is_terminal_json(self, event: dict) -> bool:
        return super()._is_terminal_json(event) or _is_stop(event)

    def _pre_spawn_events(self, prompt: str) -> list[dict[str, Any]]:
        # OpenCode's stdout stream never carries the user's own message
        # (upstream #29997), so ``transcript/prompts`` would come back empty for
        # every headless turn. Record it ourselves, before the spawn, so the
        # transcript is complete regardless of what the CLI prints.
        return [self._user_prompt_event(prompt)]

    def _terminal_synthetic_event(self) -> dict[str, Any] | None:
        synthetic = super()._terminal_synthetic_event()
        if synthetic is not None:
            return synthetic
        # A clean exit that printed no terminal ``step_finish`` still ended the
        # turn (upstream #26855 reports this can happen). Close it explicitly so
        # ``tail_status`` can reach COMPLETE instead of hanging on the last
        # non-terminal line.
        if self._proc and self._proc.returncode == 0:
            return {"type": "flowpad.result", "sessionID": self._session_id, "exitCode": 0, "reason": "synthetic-terminal"}
        return None

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
        argv, env_from_opts, stdin = opts.to_spawn(instruction=prompt, system_prompt_append=context.instructions)
        env = build_worker_spawn_env("opencode", env_from_opts)
        argv = resolve_worker_argv0("opencode", argv, env)
        return argv, env, stdin


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
    from flow_sdk.builtin.agentic_process.cli_drivers.opencode.config_gen import (
        config_for_assets_dir,
    )

    # This path has a process_id and a context, never the process itself, so the
    # attached MCP servers arrive already rendered on the context. Reading them
    # from anywhere else here is how opencode ends up with MCP on the PTY path
    # and silently without it on the headless one.
    mcp = dict(context.mcp_config_fragment or {})
    # Extra mounted roots (the Flowpad Assistant, a project's context folders,
    # ``additional_dirs``) are ``--add-dir`` for every other vendor and have NO
    # argv spelling here, so this file is their only route to the worker too.
    add_dirs = list(context.add_dirs or [])

    if not process_id:
        return None
    dirs = list(context.custom_instruction_dirs or [])
    if not dirs:
        # No instruction assets, but attached servers and extra mounted roots
        # still need a config. Whether there is anything worth writing is the
        # generator's call, not ours.
        generated = config_for_assets_dir(process_id, None, mcp, add_dirs)
        return str(generated) if generated else None
    candidate = Path(dirs[0])
    if candidate.is_file():
        # Already a generated config (``headless_prompt`` built it, add_dirs
        # included).
        return str(candidate)
    if not candidate.is_dir():
        return None

    generated = config_for_assets_dir(process_id, candidate, mcp, add_dirs)
    return str(generated) if generated else None
