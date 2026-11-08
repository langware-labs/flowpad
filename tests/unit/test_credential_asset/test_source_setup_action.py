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


async def test_a_source_created_from_the_cli_belongs_to_the_open_project_and_can_be_set_up(
    home, project, started, monkeypatch, tmp_path
):
    """``flow source create`` outside any project folder used to land the source in the user scope, so its
    Set up answered NO_SETUP_PROJECT. It now scopes the source the way the app does: to the project open
    there (the last active one), through the same ``project/<id>/data_source`` route."""
    import asyncio
    import time

    from typer.testing import CliRunner

    from flow_sdk.cli import flow_cli
    from flow_sdk.cli.commands import _common, source_cmd
    from tests.unit._graph_client import call_local

    project.last_active_at = int(time.time() * 1000)
    await project.save()
    loop = asyncio.get_running_loop()

    def over_http(method):
        def send(url, payload=None, *, params=None, on_error, **_):
            path = url.split("/api/v1/graph/", 1)[1]
            resp = asyncio.run_coroutine_threadsafe(call_local(method, path, json=payload, params=params), loop).result()
            body = resp.json()
            if resp.status_code >= 400:
                on_error(resp.status_code, body)
            return body.get("data")

        return send

    get, post = over_http("GET"), over_http("POST")
    monkeypatch.setattr(_common, "get_graph_json", lambda url, *, params=None, on_error: get(url, params=params, on_error=on_error))
    monkeypatch.setattr(_common, "post_graph_json", lambda url, payload=None, *, on_error, **kw: post(url, payload, on_error=on_error))
    monkeypatch.setattr(source_cmd, "post_graph_json", lambda url, payload=None, *, on_error, **kw: post(url, payload, on_error=on_error))
    monkeypatch.setattr(source_cmd, "discover_port", lambda required=True: 1)
    monkeypatch.chdir(tmp_path)  # no project folder here

    result = await asyncio.to_thread(
        CliRunner().invoke,
        flow_cli.app,
        ["source", "create", _Mailbox.provider, "--name", "Acme support", "--config", "address=me@x.test"],
    )
    assert result.exit_code == 0, result.output

    import json

    source = await DataSource.get_by_id(json.loads(result.stdout)["source"]["id"])
    assert str((await source.setup_project()).id) == str(project.id)
    answer = await source.setup_action()
    assert started == [(str(project.id), str(source.typeid))]
    assert answer.data == {"run": project_setup.setup_run_address(str(project.id), str(source.typeid))}
