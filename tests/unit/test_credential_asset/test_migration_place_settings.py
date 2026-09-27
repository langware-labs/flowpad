"""The boot lift of per-machine settings: a WAHA row written before 0.2.178 still carries ``base_url`` /
``webhook_url`` in ``data_source.json``; they move into the ``waha`` credential at this computer and leave
the file. Idempotent; a value this computer already holds is kept; names only are reported."""
from __future__ import annotations

import json

import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.credential_resolver import resolve_project_secrets
from flow_sdk.builtin.credential_service import save_credential
from flow_sdk.builtin.credential_store import Placement
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.ingest.testing import make_data_source
from flow_sdk.migrations.migration_2026_09_place_settings import lift

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

URL = "http://localhost:3010"
HOOK = "http://host.docker.internal:6001/api/v1/data_source/webhook/waha"


@pytest.fixture
def waha_template(catalogue, instance_config):
    return catalogue("waha")


async def _old_waha_row(project) -> DataSource:
    """A WAHA source as 0.2.177 saved it: the two URLs in its config."""
    agent = Agent(name="waha-agent", project_id=str(project.id))
    await agent.save()
    row = make_data_source("waha", name="old waha", owner=f"agent-{agent.id}", config={"session": "default"})
    await row.save()
    row.config = {**row.config, "base_url": URL, "webhook_url": HOOK}
    await row.save()
    return await DataSource.get_by_id(str(row.id))


async def _here(project, *names: str) -> dict:
    values = await resolve_project_secrets(project, only=names, placement=await Placement.of(None))
    return {k: v.get_secret_value() for k, v in values.items()}


async def test_an_old_row_moves_its_urls_into_the_credential_and_out_of_the_file(project, waha_template):
    row = await _old_waha_row(project)

    report = await lift(dry_run=False)
    stamped = await lift(dry_run=False)
    again = await lift(dry_run=False, force=True)

    assert report.moved == ["old waha: base_url → WAHA_BASE_URL", "old waha: webhook_url → WAHA_WEBHOOK_URL"]
    assert await _here(project, "WAHA_BASE_URL", "WAHA_WEBHOOK_URL") == {"WAHA_BASE_URL": URL, "WAHA_WEBHOOK_URL": HOOK}
    stored = await DataSource.get_by_id(str(row.id))
    assert "base_url" not in stored.config and "webhook_url" not in stored.config
    assert stamped.moved == [], "once per instance: a row cloned in later carries another machine's value"
    assert (again.moved, again.kept, again.failed) == ([], [], []), "a stripped row carries nothing to move"
    assert URL not in json.dumps(report.lines()), "names only"


async def test_a_value_this_computer_already_holds_is_kept(project, waha_template):
    await save_credential(scope="project", project_id=str(project.id),
                          manifest={"name": "waha", "vars": {"WAHA_BASE_URL": {"secret": False}}, "setup": "x"},
                          values={"WAHA_BASE_URL": "http://already-here:3010"})
    await _old_waha_row(project)

    report = await lift(dry_run=False)

    assert report.kept == ["old waha: WAHA_BASE_URL"]
    assert report.moved == ["old waha: webhook_url → WAHA_WEBHOOK_URL"], "a kept value is not reported moved"
    assert await _here(project, "WAHA_BASE_URL", "WAHA_WEBHOOK_URL") == {
        "WAHA_BASE_URL": "http://already-here:3010", "WAHA_WEBHOOK_URL": HOOK,
    }


async def test_a_dry_run_changes_nothing(project, waha_template):
    row = await _old_waha_row(project)

    report = await lift(dry_run=True)

    assert len(report.moved) == 2 and "would move" in report.lines()[0]
    assert (await DataSource.get_by_id(str(row.id))).config.get("base_url") == URL


async def test_the_urls_are_part_of_what_a_waha_agent_needs_wherever_it_runs(project):
    """A per-machine setting is a credential variable: the agent's requirement names it, so a deployment
    without its own value is refused before a machine starts, and use mine / placement move it."""
    from flow_sdk.builtin.readiness import requirements_of_source

    row = make_data_source("waha", name="new waha", config={"session": "default"})

    (need,) = await requirements_of_source(row)

    assert (need.kind, need.name) == ("credential", "waha")
    assert set(need.vars) == {"WAHA_API_KEY", "WAHA_WEBHOOK_HMAC", "WAHA_BASE_URL", "WAHA_WEBHOOK_URL"}
