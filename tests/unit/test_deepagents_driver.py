"""Unit tests for the Deep Agents driver's per-turn bookkeeping
(cli_drivers/deepagents/driver.py) — not the runner subprocess itself.

Isolation matches tests/unit/test_api_auth_binding.py: a temp FLOW_HOME + fresh
instance singleton so the process's shadow dir resolves headlessly.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from cryptography.fernet import Fernet


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    for name in ("FLOW_HOME", "FLOW_INSTANCE", "SOD_ENC_KEY", "FLOWPAD_SKIP_DOTENV"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", "deepagentsdrivertest")
    monkeypatch.setenv("SOD_ENC_KEY", Fernet.generate_key().decode())
    from flow_sdk.instance_settings import reset_instance_settings

    reset_instance_settings()
    yield
    reset_instance_settings()


def _write_transcript(process_id: str, events: list[dict]) -> None:
    from flow_sdk.builtin.agentic_process.cli_drivers.deepagents.session_history import (
        deepagents_transcript_path_for_process,
    )

    path = deepagents_transcript_path_for_process(process_id)
    path.write_text("\n".join(json.dumps(e) for e in events) + "\n", encoding="utf-8")


async def test_resolved_model_slug_syncs_to_the_transcripts_last_init(env) -> None:
    """The exact bug this exists for: the pre-spawn stamp says the tier default
    (the model that got REJECTED); the transcript's own last ``init`` — written
    by the runner's in-process retry — names what actually ran. A display that
    trusts the pre-spawn stamp over the transcript shows the wrong model even
    though the turn succeeded on a different one."""
    from flow_sdk.api.api_types.identifier import mint_uuid
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.builtin.agentic_process.cli_drivers.deepagents.driver import _sync_resolved_model_slug
    from flow_sdk.flowpad_types.enums.worker_enums import WorkerType

    process = AgenticProcess(
        id=mint_uuid(),
        worker_type=WorkerType.DEEPAGENTS,
        workdir="/tmp",
        pty_mode=False,
        load_flowpad_assistant=False,
    )
    process.resolved_model_slug = "z-ai/glm-5.3-flash"  # the pre-spawn stamp, before the retry
    _write_transcript(
        str(process.id),
        [
            {"type": "init", "model": "z-ai/glm-5.3-flash"},
            {"type": "user", "text": "install it"},
            {"type": "error", "message": "model z-ai/glm-5.3-flash not allowed by endpoint AI Course budget"},
            {"type": "error", "message": "could not fall back...", "kind": "chain"},
            {"type": "result", "subtype": "error", "is_error": True},
            {"type": "init", "model": "anthropic/claude-haiku-4.5"},  # the retry that actually ran
            {"type": "user", "text": "install it"},
            {"type": "text", "text": "done"},
            {"type": "result", "subtype": "success", "is_error": False},
        ],
    )

    await _sync_resolved_model_slug(process)

    assert process.resolved_model_slug == "anthropic/claude-haiku-4.5"


async def test_resolved_model_slug_is_left_alone_with_no_transcript(env) -> None:
    """Nothing has run yet (or the tee never opened) — no crash, no false update."""
    from flow_sdk.api.api_types.identifier import mint_uuid
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.builtin.agentic_process.cli_drivers.deepagents.driver import _sync_resolved_model_slug
    from flow_sdk.flowpad_types.enums.worker_enums import WorkerType

    process = AgenticProcess(
        id=mint_uuid(),
        worker_type=WorkerType.DEEPAGENTS,
        workdir="/tmp",
        pty_mode=False,
        load_flowpad_assistant=False,
    )

    await _sync_resolved_model_slug(process)

    assert process.resolved_model_slug is None


async def test_resolved_model_slug_matches_the_pre_spawn_stamp_when_no_retry_happened(env) -> None:
    """The common case — one ``init``, no rejection — must not spuriously touch the field."""
    from flow_sdk.api.api_types.identifier import mint_uuid
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.builtin.agentic_process.cli_drivers.deepagents.driver import _sync_resolved_model_slug
    from flow_sdk.flowpad_types.enums.worker_enums import WorkerType

    process = AgenticProcess(
        id=mint_uuid(),
        worker_type=WorkerType.DEEPAGENTS,
        workdir="/tmp",
        pty_mode=False,
        load_flowpad_assistant=False,
    )
    process.resolved_model_slug = "z-ai/glm-5.3-flash"
    _write_transcript(
        str(process.id),
        [
            {"type": "init", "model": "z-ai/glm-5.3-flash"},
            {"type": "user", "text": "install it"},
            {"type": "text", "text": "done"},
            {"type": "result", "subtype": "success", "is_error": False},
        ],
    )

    await _sync_resolved_model_slug(process)

    assert process.resolved_model_slug == "z-ai/glm-5.3-flash"


async def test_headless_prompt_syncs_only_after_the_turn_actually_finishes(monkeypatch, env) -> None:
    """``run_headless_turn`` SCHEDULES the turn and returns almost immediately ("started", not
    "finished") — syncing right after that ``await`` would read the transcript before the
    subprocess has even launched. This pins the fix: the sync must ride ``on_turn_finally``,
    the seam that fires once the turn's stream is actually drained, not a call bolted on after
    the scheduling call returns."""
    from flow_sdk.api.api_types.identifier import mint_uuid
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.builtin.agentic_process.cli_drivers import api_auth as api_auth_module
    from flow_sdk.builtin.agentic_process.cli_drivers.deepagents import driver as driver_module
    from flow_sdk.flowpad_types.enums.worker_enums import WorkerType
    from flow_sdk.lm_api import LMApiProvider, set_lm_api
    from flow_sdk.responses.response import ApiSuccessResponse

    set_lm_api("sk-or-test", LMApiProvider.OPENROUTER)
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_capability_kind
    from flow_sdk.builtin.capability import Capability

    cap = await Capability.get_by_kind(worker_capability_kind("deepagents"))
    assert cap is not None
    cap.auth_mode = "api"
    cap.api_provider = "openrouter"
    await cap.save(notify=False)

    process = AgenticProcess(
        id=mint_uuid(),
        worker_type=WorkerType.DEEPAGENTS,
        workdir="/tmp",
        pty_mode=False,
        load_flowpad_assistant=False,
    )
    process.resolved_model_slug = "z-ai/glm-5.3-flash"

    async def no_op(*_args, **_kwargs):
        return None

    async def no_auth(*_args, **_kwargs):
        return None

    monkeypatch.setattr(AgenticProcess, "get_project", no_op)
    monkeypatch.setattr(AgenticProcess, "save", no_op)
    monkeypatch.setattr(AgenticProcess, "prepare_system_instruction_assets", no_op)
    monkeypatch.setattr(api_auth_module, "stamp_api_model", no_auth)

    captured: dict[str, object] = {}

    async def fake_run_headless_turn(*_args, on_turn_finally=None, **_kwargs):
        captured["on_turn_finally"] = on_turn_finally
        # The real thing does NOT await the turn before returning — proven by calling
        # neither here nor before this point in the test.
        return ApiSuccessResponse(data={"status": "started", "worker": "deepagents"})

    monkeypatch.setattr(driver_module, "run_headless_turn", fake_run_headless_turn)

    driver = driver_module.DeepAgentsDriver()
    await driver.headless_prompt(process, "install ripgrep")

    assert process.resolved_model_slug == "z-ai/glm-5.3-flash", "not synced before the turn finished"
    assert callable(captured.get("on_turn_finally")), "headless_prompt must hand run_headless_turn the sync callback"

    # Only NOW does the transcript exist — exactly as it would once the real turn's stream
    # has drained, whether or not an in-process model-fallback retry happened.
    _write_transcript(
        str(process.id),
        [
            {"type": "init", "model": "z-ai/glm-5.3-flash"},
            {"type": "error", "message": "model z-ai/glm-5.3-flash not allowed by endpoint AI Course budget"},
            {"type": "result", "subtype": "error", "is_error": True},
            {"type": "init", "model": "anthropic/claude-haiku-4.5"},
            {"type": "text", "text": "done"},
            {"type": "result", "subtype": "success", "is_error": False},
        ],
    )
    await captured["on_turn_finally"]()

    assert process.resolved_model_slug == "anthropic/claude-haiku-4.5"
