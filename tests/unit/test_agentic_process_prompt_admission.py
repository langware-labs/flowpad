"""Deterministic concurrency guards for headless AgenticProcess turns."""

from __future__ import annotations

import asyncio

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process import agentic_process as ap_mod
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse


class _GatedHeadlessDriver:
    """Keep the first call in setup while a concurrent caller is attempted."""

    def __init__(self) -> None:
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.calls = 0

    async def headless_prompt(self, _process: AgenticProcess, _instruction: str):
        self.calls += 1
        if self.calls == 1:
            self.entered.set()
            await self.release.wait()
        return ApiSuccessResponse(data={"status": "started"})


@pytest.mark.asyncio
async def test_concurrent_direct_headless_prompt_rejects_second_turn(monkeypatch) -> None:
    """Admission is held before the driver registers a worker or returns."""
    driver = _GatedHeadlessDriver()
    monkeypatch.setattr(
        AgenticProcess,
        "driver",
        property(lambda _self: driver),
    )
    process = AgenticProcess(id=mint_uuid(), pty_mode=False)

    first = asyncio.create_task(process.prompt("first"))
    await driver.entered.wait()
    try:
        assert ap_mod.prompt_worker_active(process.id) is True

        second = await process.prompt("second")
        assert isinstance(second, ApiFailResponse)
        assert second.status_code == 409
        assert second.message == "another prompt turn is already in flight for this process"
        assert driver.calls == 1
    finally:
        driver.release.set()
        first_result = await first

    assert isinstance(first_result, ApiSuccessResponse)
    assert ap_mod.prompt_worker_active(process.id) is False


def test_prompt_worker_registration_and_cleanup_are_owner_safe() -> None:
    """A stale turn cannot overwrite or deregister the current worker."""
    process_id = mint_uuid()
    admission = ap_mod.try_admit_prompt(process_id)
    assert admission is not None
    assert ap_mod.prompt_worker_active(process_id) is True

    owner = object()
    stale = object()
    try:
        ap_mod.register_prompt_worker(process_id, owner)
        assert ap_mod._PROMPT_WORKERS[process_id] is owner
        assert process_id not in ap_mod._PROMPT_ADMISSIONS

        with pytest.raises(RuntimeError, match="prompt worker already registered"):
            ap_mod.register_prompt_worker(process_id, stale)
        assert ap_mod._PROMPT_WORKERS[process_id] is owner

        assert ap_mod.unregister_prompt_worker(process_id, stale) is False
        assert ap_mod._PROMPT_WORKERS[process_id] is owner
        assert ap_mod.unregister_prompt_worker(process_id, owner) is True
        assert ap_mod.prompt_worker_active(process_id) is False
    finally:
        ap_mod.unregister_prompt_worker(process_id, owner)
        ap_mod.release_prompt_admission(process_id, admission)


def test_stale_admission_token_cannot_release_new_owner() -> None:
    """Admission cleanup is conditional on token identity."""
    process_id = mint_uuid()
    first = ap_mod.try_admit_prompt(process_id)
    assert first is not None
    assert ap_mod.release_prompt_admission(process_id, first) is True

    second = ap_mod.try_admit_prompt(process_id)
    assert second is not None
    try:
        assert ap_mod.release_prompt_admission(process_id, first) is False
        assert ap_mod.prompt_worker_active(process_id) is True
    finally:
        ap_mod.release_prompt_admission(process_id, second)
