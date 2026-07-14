"""Deterministic cleanup guarantees for headless AgenticProcess turns.

Two regressions:

* The prompt-worker slot must be released when a driver raises AFTER
  ``register_prompt_worker`` but BEFORE the turn task is scheduled — otherwise
  the slot leaks and every subsequent prompt is permanently rejected with a 409
  (``prompt_worker_active`` pinned True forever).

* A cancel whose worker wound its own turn down gracefully (codex SIGINT /
  copilot synthetic terminal) must NOT also write the flowpad sidecar abort
  marker — the worker already recorded the abort in its transcript, so a sidecar
  marker would replay as a DUPLICATE turn-terminated STATUS.
"""

from __future__ import annotations

import importlib

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process import agentic_process as ap_mod
from flow_sdk.builtin.agentic_process.turn_abort import turn_events_path
from flow_sdk.builtin.process_lifecycle import ProcessStatus
from flow_sdk.responses.response import ApiSuccessResponse

_DRIVERS = [
    ("flow_sdk.builtin.agentic_process.cli_drivers.claude.driver", "ClaudeDriver"),
    ("flow_sdk.builtin.agentic_process.cli_drivers.codex.driver", "CodexDriver"),
    ("flow_sdk.builtin.agentic_process.cli_drivers.copilot.driver", "CopilotDriver"),
]


@pytest.mark.parametrize(("module_path", "class_name"), _DRIVERS)
@pytest.mark.asyncio
async def test_driver_setup_raise_releases_prompt_worker_slot(
    module_path, class_name, tmp_path, monkeypatch
):
    """A raise between registration and task scheduling frees the slot.

    ``make_turn_session_adopter`` is the last thing every driver does after
    ``register_prompt_worker`` and before ``asyncio.create_task(_run_turn)`` —
    forcing it to raise reproduces the exact window where the caller's admission
    ``finally`` can no longer clean the (already handed-off) slot.
    """
    mod = importlib.import_module(module_path)
    driver = getattr(mod, class_name)()

    async def _fake_prepare(_self):
        return None

    async def _fake_secret_env(env, _process):
        return env

    def _boom(_self, _log_prefix):
        raise RuntimeError("setup boom after register")

    monkeypatch.setattr(AgenticProcess, "prepare_system_instruction_assets", _fake_prepare)
    monkeypatch.setattr(AgenticProcess, "make_turn_session_adopter", _boom)
    # Each driver imports the secret-env helper into its own namespace.
    monkeypatch.setattr(mod, "apply_worker_secret_env", _fake_secret_env)

    process = AgenticProcess(id=mint_uuid(), pty_mode=False)
    process.workdir = str(tmp_path)
    process.session_id = "sess-cleanup"
    # Skip the lifecycle save (no DB in this unit test).
    process.status = ProcessStatus.RUNNING.value

    assert ap_mod.prompt_worker_active(process.id) is False
    try:
        with pytest.raises(RuntimeError, match="setup boom after register"):
            await driver.headless_prompt(process, "hi")

        # The worker slot was released — a leak would keep this True and 409 the
        # next prompt forever.
        assert ap_mod.prompt_worker_active(process.id) is False
        # And a fresh turn can be admitted (no lingering 409).
        token = ap_mod.try_admit_prompt(process.id)
        assert token is not None
        ap_mod.release_prompt_admission(process.id, token)
    finally:
        ap_mod._PROMPT_WORKERS.pop(process.id, None)
        ap_mod._PROMPT_ADMISSIONS.pop(process.id, None)


class _FakeWorker:
    """Minimal stand-in for a registered stream worker at the cancel choke point."""

    def __init__(self, *, cancelled_gracefully: bool) -> None:
        self._graceful = cancelled_gracefully
        self.closed = False

    @property
    def cancelled_gracefully(self) -> bool:
        return self._graceful

    async def close_session(self) -> None:
        self.closed = True


@pytest.mark.asyncio
async def test_graceful_cancel_skips_sidecar_abort_marker(tmp_path, monkeypatch):
    """A graceful cancel writes NO flowpad sidecar marker (worker self-records)."""
    monkeypatch.setattr(AgenticProcess, "_record_dir", lambda _self: tmp_path)
    process = AgenticProcess(id=mint_uuid(), pty_mode=False)
    process.session_id = "sess-graceful"

    worker = _FakeWorker(cancelled_gracefully=True)
    ap_mod._PROMPT_WORKERS[process.id] = worker
    try:
        resp = await process._http_cancel_prompt()
    finally:
        ap_mod._PROMPT_WORKERS.pop(process.id, None)

    assert isinstance(resp, ApiSuccessResponse)
    assert resp.data == {"cancelled": True, "transport": "cli"}
    assert worker.closed is True
    # No sidecar marker → no duplicate abort on history replay.
    assert not turn_events_path(tmp_path).exists()


@pytest.mark.asyncio
async def test_forced_cancel_writes_exactly_one_sidecar_marker(tmp_path, monkeypatch):
    """A force-killed worker recorded nothing → exactly one durable sidecar marker."""
    monkeypatch.setattr(AgenticProcess, "_record_dir", lambda _self: tmp_path)
    process = AgenticProcess(id=mint_uuid(), pty_mode=False)
    process.session_id = "sess-forced"

    worker = _FakeWorker(cancelled_gracefully=False)
    ap_mod._PROMPT_WORKERS[process.id] = worker
    try:
        resp = await process._http_cancel_prompt()
    finally:
        ap_mod._PROMPT_WORKERS.pop(process.id, None)

    assert isinstance(resp, ApiSuccessResponse)
    marker_path = turn_events_path(tmp_path)
    assert marker_path.exists()
    lines = [ln for ln in marker_path.read_text(encoding="utf-8").splitlines() if ln.strip()]
    assert len(lines) == 1
