"""The shared headless-turn scaffold, and the per-vendor divergences it keeps.

`run_headless_turn` replaced four copies of the prompt-slot ownership protocol.
The copies were not identical, and the differences are not cosmetic:

* claude saves RUNNING *before* registering the worker;
* claude logs a failed `emit_flow_data` at ERROR where the others log DEBUG;
* claude strips a materialised `fork_session_id` in the turn's `finally`;
* every driver's records must stay under its OWN logger name, or per-vendor log
  filters and `caplog` assertions break silently.

Each of those is pinned below. `test_agentic_process_turn_cleanup.py` covers the
slot-leak invariant through the real drivers for all four vendors; the ordering
guarantees inside the turn are exercised here against the runner directly,
because no driver surfaces them.
"""

from __future__ import annotations

import asyncio
import inspect
import logging

import pytest

from flow_sdk.builtin.agentic_process import agentic_process as ap_mod
from flow_sdk.builtin.agentic_process.cli_drivers import headless_turn
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    WorkerSpawnError,
    get_driver,
)

_VENDORS = ("claude", "codex", "copilot", "opencode")


def _driver_cls(vendor: str):
    """The registry is the one place that maps a vendor to its driver class.

    Scanning a module's `vars()` for a name ending in `Driver` would silently
    pick a different class the day a driver module grows a second one.
    """
    return type(get_driver(vendor))


def _headless_prompt_source(vendor: str) -> str:
    return inspect.getsource(_driver_cls(vendor).headless_prompt)


# ── the seam's shape ────────────────────────────────────────────────────────


def test_it_is_a_function_not_a_base_class():
    """A base class would grant attributes two contract tests assert are absent.

    `test_cli_driver_contract.py` checks `not hasattr(CodexDriver,
    "report_event")` and `not hasattr(OpenCodeDriver,
    "preassign_interactive_session_id")`. `WorkerDriver` is a structural
    Protocol on purpose; a free function taking the driver as an argument grants
    nothing.
    """
    assert inspect.isfunction(headless_turn.run_headless_turn)
    assert "driver" in inspect.signature(headless_turn.run_headless_turn).parameters


def test_the_seam_starts_at_registration_not_at_prompt_entry():
    """Env/secret resolution must stay in each driver's own namespace.

    `test_agentic_process_turn_cleanup.py` monkeypatches
    `mod.apply_worker_secret_env` per driver module. If the shared runner
    swallowed that call the patch target would vanish and the slot-leak test
    would stop testing anything.
    """
    source = inspect.getsource(headless_turn)
    # A CALL, not the docstring mention explaining why it stays in the driver.
    assert "apply_worker_secret_env(" not in source
    assert "register_prompt_worker(process.id, worker)" in source


@pytest.mark.parametrize("vendor", _VENDORS)
def test_every_driver_delegates_and_keeps_its_own_logger(vendor):
    source = _headless_prompt_source(vendor)
    assert "run_headless_turn(" in source, f"{vendor} re-inlined the scaffold"
    # Passing the driver's own logger is what keeps records under
    # `…cli_drivers.<vendor>.driver` instead of the shared module's name.
    assert "logger=logger" in source, f"{vendor} would emit under the shared module's name"
    # The slot protocol now lives in exactly one place.
    assert "unregister_prompt_worker" not in source, f"{vendor} still owns slot teardown"


# ── the divergences, pinned ─────────────────────────────────────────────────


def test_claude_alone_skips_the_running_save():
    """Claude saves RUNNING in its prologue, BEFORE registering the worker."""
    source = _headless_prompt_source("claude")
    assert "save_running_status=False" in source
    # …and the save really is still there, ahead of the delegation.
    assert source.index("ProcessStatus.RUNNING") < source.index("run_headless_turn(")


@pytest.mark.parametrize("vendor", ["codex", "copilot", "opencode"])
def test_the_other_three_take_the_running_save_default(vendor):
    assert "save_running_status=" not in _headless_prompt_source(vendor)


def test_pre_touch_is_not_a_vendor_switch():
    """Every worker answers `transcript_path`; claude answers None.

    It was briefly a `pre_touch_transcript=False` flag on claude, which hid the
    fact that `AgenticWorker` never declared the attribute at all — so the
    shared pre-touch would have raised AttributeError (which `except OSError`
    does not catch) rather than skipping. Declaring it on the ABC makes "no tee"
    an answer instead of a missing attribute.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
        AgenticWorker,
    )

    assert AgenticWorker.transcript_path is None
    assert "pre_touch_transcript" not in inspect.getsource(headless_turn)
    for vendor in _VENDORS:
        assert "pre_touch_transcript" not in _headless_prompt_source(vendor)


def test_claude_alone_raises_the_emit_failure_level():
    """Preserved, not endorsed — see run_headless_turn's docstring."""
    assert "emit_failure_level=logging.ERROR" in _headless_prompt_source("claude")
    # The runner's default is the quiet one the other three had.
    assert (
        inspect.signature(headless_turn.run_headless_turn)
        .parameters["emit_failure_level"].default
        == logging.DEBUG
    )


def test_claude_alone_supplies_turn_teardown():
    """The fork-strip block, preserved as an `on_turn_finally` callback."""
    source = _headless_prompt_source("claude")
    assert "on_turn_finally=" in source
    assert "fork_session_id" in source


# ── behaviour: the ordering guarantees the four copies each had to get right ──


class _FakeWorker:
    """Yields nothing by default; `boom` makes `execute` raise."""

    def __init__(self, *, boom: BaseException | None = None) -> None:
        self.boom = boom
        self.transcript_path = None

    async def execute(self, *, prompt, context):  # noqa: ARG002
        if self.boom is not None:
            raise self.boom
        return
        yield  # pragma: no cover - makes this an async generator

    def get_session_id(self):
        return None


class _FakeProcess:
    """Records the lifecycle calls the runner makes, in order."""

    def __init__(self, calls: list[str], *, adopter_boom: bool = False) -> None:
        self.id = "proc-headless-turn"
        self.status = "running"
        self.calls = calls
        self._adopter_boom = adopter_boom

    async def save(self):
        self.calls.append("save")

    async def notify_updated(self):
        self.calls.append("notify")

    def make_turn_session_adopter(self, _log_prefix):
        if self._adopter_boom:
            raise RuntimeError("adopter boom")

        async def _adopt(_session_id):
            return None

        return _adopt

    async def emit_flow_data(self, _payload):
        self.calls.append("emit")

    async def end_headless_turn(self, _log_prefix):
        self.calls.append("end_headless_turn")


class _FakeDriver:
    name = "fakevendor"


def _cleanup(process_id: str) -> None:
    ap_mod._PROMPT_WORKERS.pop(process_id, None)
    ap_mod._PROMPT_ADMISSIONS.pop(process_id, None)


async def _run(process, worker, **kwargs):
    return await headless_turn.run_headless_turn(
        _FakeDriver(),
        process,
        worker,
        prompt="hi",
        context=None,
        logger=logging.getLogger(__name__),
        **kwargs,
    )


@pytest.mark.asyncio
async def test_teardown_runs_after_unregister_and_before_end_of_turn():
    """Ordering is the whole point: the slot is freed first, the turn ends last."""
    calls: list[str] = []
    process = _FakeProcess(calls)
    worker = _FakeWorker()

    async def _teardown():
        # Observed from inside the callback: the slot is already released.
        calls.append(f"teardown(slot_active={ap_mod.prompt_worker_active(process.id)})")

    try:
        await _run(process, worker, on_turn_finally=_teardown)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
    finally:
        _cleanup(process.id)

    assert "teardown(slot_active=False)" in calls
    assert calls.index("teardown(slot_active=False)") < calls.index("end_headless_turn")


@pytest.mark.asyncio
async def test_teardown_failure_cannot_strand_the_turn():
    """A raise in vendor teardown must not skip `end_headless_turn`."""
    calls: list[str] = []
    process = _FakeProcess(calls)

    async def _boom():
        raise RuntimeError("teardown boom")

    try:
        await _run(process, _FakeWorker(), on_turn_finally=_boom)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
    finally:
        _cleanup(process.id)

    assert "end_headless_turn" in calls


@pytest.mark.asyncio
async def test_a_worker_error_still_ends_the_turn_and_frees_the_slot():
    calls: list[str] = []
    process = _FakeProcess(calls)

    try:
        await _run(process, _FakeWorker(boom=RuntimeError("worker boom")))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert "end_headless_turn" in calls
        assert ap_mod.prompt_worker_active(process.id) is False
    finally:
        _cleanup(process.id)


@pytest.mark.asyncio
async def test_the_slot_is_released_when_scheduling_never_happens():
    """The 409-forever guard: a raise before `create_task` must free the slot."""
    calls: list[str] = []
    process = _FakeProcess(calls, adopter_boom=True)

    try:
        with pytest.raises(RuntimeError, match="adopter boom"):
            await _run(process, _FakeWorker())
        assert ap_mod.prompt_worker_active(process.id) is False
        # And a fresh turn can be admitted — no lingering 409.
        token = ap_mod.try_admit_prompt(process.id)
        assert token is not None
        ap_mod.release_prompt_admission(process.id, token)
    finally:
        _cleanup(process.id)


def test_spawn_failure_latches_and_still_ends_the_turn():
    source = inspect.getsource(headless_turn.run_headless_turn)
    assert "latch_spawn_failure" in source
    # It is caught, not propagated — the turn must still reach its finally.
    assert "except WorkerSpawnError" in source
    assert WorkerSpawnError is not None


@pytest.mark.asyncio
async def test_the_turn_task_is_named_for_the_vendor_and_process():
    """Task names carry the vendor prefix so a hung turn is attributable.

    Derived from the driver rather than passed in — the four call sites used to
    spell it out, and a fifth vendor could have spelled it wrong.
    """
    calls: list[str] = []
    process = _FakeProcess(calls)
    before = {t.get_name() for t in asyncio.all_tasks()}
    try:
        response = await _run(process, _FakeWorker())
        names = {t.get_name() for t in asyncio.all_tasks()} - before
        await asyncio.sleep(0)
        await asyncio.sleep(0)
    finally:
        _cleanup(process.id)

    assert f"fakevendor-{process.id[:8]}" in names
    # The response carries the driver's name too, from the same one source.
    assert response.data["worker"] == "fakevendor"
