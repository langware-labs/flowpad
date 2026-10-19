"""A data source's own Set up: ``POST data_source/<id>/setup`` runs the source's node of its project's
setup tree, and ``GET data_source/<id>/setup-run`` reads that run — the caller never names the project.

Real isolated DB and project; ``start_setup`` is captured, not run (the tree and its walk are proven in
``tests/unit/test_setup_tree``).
"""
from __future__ import annotations

import pytest

from flow_sdk.builtin import project_setup
from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.data_source import NO_SETUP_PROJECT, DataSource
from flow_sdk.sources.families import RecordSource

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


class _Mailbox(RecordSource):
    provider = "setup-action-test"
    identity_config_key = "address"


@pytest.fixture
def started(monkeypatch):
    """What ``start_setup`` was asked for: ``(project id, root)`` per call."""
    DataDriver.register(DataDriver.for_class(_Mailbox, kind="datasource.test.setup_action"))
    calls: list[tuple[str, str]] = []

    async def start(project, *, root="", **_):
        calls.append((str(project.id), root))
        return project_setup.setup_run_address(str(project.id), root)

    monkeypatch.setattr(project_setup, "start_setup", start)
    return calls


async def _source(**fields) -> DataSource:
    source = DataSource(name="work mail", provider=_Mailbox.provider, config={"address": "me@x.test"}, **fields)
    await source.save()
    return source


async def test_setup_runs_the_sources_own_node_of_its_projects_tree(project, started):
    source = await _source(project_id=str(project.id))

    answer = await source.setup_action()

    assert started == [(str(project.id), str(source.typeid))]
    assert answer.data == {"run": project_setup.setup_run_address(str(project.id), str(source.typeid))}


async def test_the_run_is_read_by_the_source_alone(project, started):
    source = await _source(project_id=str(project.id))

    answer = await source.setup_run_action()

    assert answer.data == project_setup.setup_run(str(project.id), str(source.typeid))
    assert answer.data["running"] is False


async def test_a_source_no_project_holds_has_no_setup_to_run(home, started):
    source = await _source()

    answer = await source.setup_action()

    assert started == []
    assert (answer.status_code, answer.message) == (409, NO_SETUP_PROJECT)
    assert (await source.setup_run_action()).data == {"run": "", "running": False, "tree": None}
