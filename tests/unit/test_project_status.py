"""Project status: a read answers from what is stored, refreshes what is due behind it, once at a time."""

import asyncio

import pytest

from flow_sdk.builtin import credential_status
from flow_sdk.core import project_status as ps


@pytest.fixture
def status(tmp_path, monkeypatch):
    calls = []

    async def build(project_id):
        calls.append(project_id)
        await asyncio.sleep(0.01)
        return {"project_id": project_id, "ready": len(calls) > 1}

    pushes = []

    async def push(project_id):
        pushes.append(project_id)

    monkeypatch.setattr(ps, "path_of", lambda pid: tmp_path / pid / ps.STATUS_FILE)
    monkeypatch.setattr(ps, "PARTS", {ps.SETUP: (30.0, build)})
    monkeypatch.setattr(ps, "_push", push)
    monkeypatch.setattr(ps, "_seen", {})
    monkeypatch.setattr(ps, "_running", {})
    monkeypatch.setattr(ps, "_again", set())
    monkeypatch.setattr(ps, "_changed_at", {})
    ps._PARSED.clear()
    return calls, pushes


async def _settle():
    while ps._running:
        await asyncio.gather(*list(ps._running.values()))


async def test_first_read_answers_empty_then_stores_and_pushes(status):
    calls, pushes = status
    assert ps.read("p1").parts == {}
    await _settle()
    part = ps.read_stored("p1").parts[ps.SETUP]
    assert part.value == {"project_id": "p1", "ready": False}
    assert part.checked_at and not part.checking and not part.stale
    assert calls == ["p1"] and pushes  # "checking" pushed, then the answer


async def test_fresh_part_is_not_checked_again(status):
    calls, _ = status
    ps.read("p1")
    await _settle()
    ps.read("p1")
    assert not ps._running and calls == ["p1"]


async def test_many_reads_at_once_run_one_check_and_one_more(status):
    calls, _ = status
    for _ in range(10):
        ps.read("p1")
    await asyncio.sleep(0.005)  # the check is under way
    ps.mark_stale("p1")  # lands while it runs: buys exactly one more round
    await _settle()
    assert calls == ["p1", "p1"]
    assert ps.read_stored("p1").parts[ps.SETUP].value["ready"] is True


async def test_mark_stale_refreshes_a_project_on_screen_and_the_rest_on_their_next_read(status):
    import time

    calls, _ = status
    ps.read("p1")
    await _settle()
    ps._write_part("p2", ps.SETUP, checked_at=time.time(), value={})  # fresh, but nobody is looking at it
    ps.mark_stale(None)
    await _settle()
    assert calls == ["p1", "p1"]  # p1 is on screen: refreshed now
    ps.read("p2")  # p2 was not: its answer predates the change, so its next read refreshes it
    await _settle()
    assert calls == ["p1", "p1", "p2"]


async def test_a_refresh_started_inside_a_db_session_does_not_share_it(status, monkeypatch):
    # An entity write's bus hook calls mark_stale from INSIDE the writer's session; a refresh that inherited it
    # ran its reads on that session concurrently ("concurrent operations are not permitted") and could leave the
    # write lock orphaned for every other writer ("database is locked").
    from flow_sdk.db.drivers.sqlite.sqlite_driver import _standalone_session_var

    seen = []

    async def build(project_id):
        seen.append(_standalone_session_var.get())
        return {"project_id": project_id}

    monkeypatch.setattr(ps, "PARTS", {ps.SETUP: (30.0, build)})
    token = _standalone_session_var.set(object())  # the writer's open session
    try:
        ps.refresh("p1", ps.SETUP)
    finally:
        _standalone_session_var.reset(token)
    await _settle()
    assert seen == [None]

async def test_failed_refresh_keeps_the_last_answer_and_says_why(status, monkeypatch):
    ps.read("p1")
    await _settle()

    async def broken(_pid):
        raise RuntimeError("boom")

    monkeypatch.setattr(ps, "PARTS", {ps.SETUP: (30.0, broken)})
    ps.refresh("p1", ps.SETUP)
    await _settle()
    part = ps.read_stored("p1").parts[ps.SETUP]
    assert part.error == "boom" and part.value == {"project_id": "p1", "ready": False}


async def test_a_sign_in_check_runs_once_for_many_askers_until_forgotten(monkeypatch):
    runs = []

    async def run_check(check, *, workdir):
        runs.append(check)
        await asyncio.sleep(0.01)
        return ("failed", "not signed in")

    monkeypatch.setattr(credential_status, "run_check", run_check)
    credential_status.forget_signins()
    check = {"commands": {"darwin": "gcloud auth application-default print-access-token"}}
    answers = await asyncio.gather(*(credential_status._check_signin(check) for _ in range(10)))
    assert len(runs) == 1 and set(answers) == {("failed", "not signed in")}
    await credential_status._check_signin(check)
    assert len(runs) == 1  # remembered
    credential_status.forget_signins()
    await credential_status._check_signin(check)
    assert len(runs) == 2


def test_status_rides_the_row_but_never_goes_to_the_hub():
    import inspect

    from flow_sdk.builtin.project import Project

    assert "local_status" in Project.model_computed_fields
    assert '"local_status"' in inspect.getsource(Project._hub_body)
