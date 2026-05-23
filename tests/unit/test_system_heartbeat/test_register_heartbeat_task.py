"""H2 / H6: register_heartbeat_task decorator + dispatch contract."""
from __future__ import annotations

import asyncio
from typing import Any

import pytest

from flow_sdk.server import system_heartbeat as sh


pytestmark = pytest.mark.timeout(30)


@pytest.fixture(autouse=True)
def _isolated_registry(monkeypatch):
    """Each test gets a fresh task registry so failures don't pollute siblings."""
    monkeypatch.setattr(sh, "_tasks", {})
    yield


def test_register_adds_to_registry() -> None:
    @sh.register_heartbeat_task("task_a")
    async def _t() -> None: ...

    assert sh._registered_tasks() == {"task_a": _t}


def test_re_register_replaces() -> None:
    @sh.register_heartbeat_task("dup")
    async def _first() -> None: ...

    @sh.register_heartbeat_task("dup")
    async def _second() -> None: ...

    assert sh._registered_tasks()["dup"] is _second


def test_list_registered_reflects_registry() -> None:
    @sh.register_heartbeat_task("foo")
    async def _f() -> None: ...

    listing = sh.list_registered()
    assert any(item["name"] == "foo" and item["is_async"] is True for item in listing)


@pytest.mark.asyncio
async def test_dispatch_runs_all_tasks() -> None:
    runs: list[str] = []

    @sh.register_heartbeat_task("a")
    async def _a() -> None:
        runs.append("a")

    @sh.register_heartbeat_task("b")
    async def _b() -> None:
        runs.append("b")

    await sh._dispatch_heartbeat(None, [])
    assert sorted(runs) == ["a", "b"]


@pytest.mark.asyncio
async def test_dispatch_isolates_task_failures(caplog) -> None:
    runs: list[str] = []

    @sh.register_heartbeat_task("crashy")
    async def _crash() -> None:
        raise RuntimeError("intentional")

    @sh.register_heartbeat_task("survivor")
    async def _ok() -> None:
        runs.append("survivor")

    with caplog.at_level("ERROR"):
        await sh._dispatch_heartbeat(None, [])
    assert runs == ["survivor"]
    assert any("heartbeat task 'crashy' raised" in r.message for r in caplog.records)


@pytest.mark.asyncio
async def test_dispatch_enforces_per_task_timeout(monkeypatch, caplog) -> None:
    """Slow task is cancelled at TASK_TIMEOUT_SECONDS; siblings still run."""
    monkeypatch.setattr(sh, "TASK_TIMEOUT_SECONDS", 0.1)
    fast_ran: list[str] = []

    @sh.register_heartbeat_task("slow")
    async def _slow() -> None:
        await asyncio.sleep(5)  # >> TASK_TIMEOUT_SECONDS

    @sh.register_heartbeat_task("fast")
    async def _fast() -> None:
        fast_ran.append("fast")

    with caplog.at_level("WARNING"):
        await sh._dispatch_heartbeat(None, [])
    assert fast_ran == ["fast"]
    assert any("exceeded" in r.message and "budget" in r.message for r in caplog.records)
