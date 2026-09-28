"""The boot lift of per-machine settings: a row written before its driver mapped a config field into
``auth.vars`` still carries it in ``data_source.json``; it moves into the driver's credential at this
computer and leaves the file. Idempotent; a value this computer already holds is kept; names only are
reported. (WAHA was the case that needed it, in 0.2.178; it is an external connector now, so a shipped
driver with two mapped variables — the WhatsApp Cloud API — stands in: the lift names no driver.)"""
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

TOKEN = "EAAG-old-token"
HOOK = "https://hub.example/api/v1/webhook/relay/abc"


@pytest.fixture
def whatsapp_template(catalogue, instance_config):
    return catalogue("whatsapp")


async def _old_row(project) -> DataSource:
    """A source as an older release saved it: two per-machine values in its config."""
    agent = Agent(name="wa-agent", project_id=str(project.id))
    await agent.save()
    row = make_data_source("whatsapp", name="old wa", owner=f"agent-{agent.id}", config={})
    await row.save()
    row.config = {**row.config, "access_token": TOKEN, "webhook_url": HOOK}
    await row.save()
    return await DataSource.get_by_id(str(row.id))


async def _here(project, *names: str) -> dict:
    values = await resolve_project_secrets(project, only=names, placement=await Placement.of(None))
    return {k: v.get_secret_value() for k, v in values.items()}


async def test_an_old_row_moves_its_urls_into_the_credential_and_out_of_the_file(project, whatsapp_template):
    row = await _old_row(project)

    report = await lift(dry_run=False)
    stamped = await lift(dry_run=False)
    again = await lift(dry_run=False, force=True)

    assert report.moved == ["old wa: access_token → FLOW_WHATSAPP_TOKEN", "old wa: webhook_url → FLOW_WHATSAPP_WEBHOOK_URL"]
    assert await _here(project, "FLOW_WHATSAPP_TOKEN", "FLOW_WHATSAPP_WEBHOOK_URL") == {"FLOW_WHATSAPP_TOKEN": TOKEN, "FLOW_WHATSAPP_WEBHOOK_URL": HOOK}
    stored = await DataSource.get_by_id(str(row.id))
    assert "access_token" not in stored.config and "webhook_url" not in stored.config
    assert stamped.moved == [], "once per instance: a row cloned in later carries another machine's value"
    assert (again.moved, again.kept, again.failed) == ([], [], []), "a stripped row carries nothing to move"
    assert TOKEN not in json.dumps(report.lines()), "names only"


async def test_a_value_this_computer_already_holds_is_kept(project, whatsapp_template):
    await save_credential(scope="project", project_id=str(project.id),
                          manifest={"name": "whatsapp", "vars": {"FLOW_WHATSAPP_TOKEN": {"secret": True}}, "setup": "x"},
                          values={"FLOW_WHATSAPP_TOKEN": "EAAG-already-here"})
    await _old_row(project)

    report = await lift(dry_run=False)

    assert report.kept == ["old wa: FLOW_WHATSAPP_TOKEN"]
    assert report.moved == ["old wa: webhook_url → FLOW_WHATSAPP_WEBHOOK_URL"], "a kept value is not reported moved"
    assert await _here(project, "FLOW_WHATSAPP_TOKEN", "FLOW_WHATSAPP_WEBHOOK_URL") == {
        "FLOW_WHATSAPP_TOKEN": "EAAG-already-here", "FLOW_WHATSAPP_WEBHOOK_URL": HOOK,
    }


async def test_a_dry_run_changes_nothing(project, whatsapp_template):
    row = await _old_row(project)

    report = await lift(dry_run=True)

    assert len(report.moved) == 2 and "would move" in report.lines()[0]
    assert (await DataSource.get_by_id(str(row.id))).config.get("access_token") == TOKEN


async def test_the_mapped_values_are_part_of_what_an_agent_needs_wherever_it_runs(project):
    """A per-machine setting is a credential variable: the agent's requirement names it, so a deployment
    without its own value is refused before a machine starts, and use mine / placement move it."""
    from flow_sdk.builtin.readiness import requirements_of_source

    row = make_data_source("whatsapp", name="new wa", config={})

    (need,) = await requirements_of_source(row)

    assert (need.kind, need.name) == ("credential", "whatsapp")
    assert set(need.vars) == {"FLOW_WHATSAPP_TOKEN", "FLOW_WHATSAPP_SECRET", "FLOW_WHATSAPP_WEBHOOK_URL"}
