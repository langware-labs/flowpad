"""Readiness reads what runs HERE too: a source still in setup, a web app whose server does not answer.

A project whose values are all set used to read "ready" while its WhatsApp source sat in setup and its
site was down; the "Setup required" button now says so.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from flow_sdk.builtin import project_setup, webapp_setup
from flow_sdk.builtin.faas.micro_app import WebApp
from flow_sdk.schema.data_spec.project_setup_spec import REQUIREMENT_SOURCE, REQUIREMENT_WEBAPP
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode, ReturnedValue

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


@pytest.fixture
def running(monkeypatch):
    state = SimpleNamespace(sources=[], apps=[], up=set())

    async def sources(_project):
        return state.sources

    async def apps(_q):
        return state.apps

    async def step(webapp, which, *, check):
        held = webapp in state.up
        return ReturnedValue(exit_code=ExitCode.OK if held else ExitCode.NOT_YET, detail="" if held else "site is not running")

    monkeypatch.setattr(project_setup, "project_sources", sources)
    monkeypatch.setattr(WebApp, "get_all", apps)
    monkeypatch.setattr(webapp_setup, "step", step)
    return state


async def test_a_source_in_setup_and_a_dead_site_make_the_project_not_ready(project, running):
    running.sources = [SimpleNamespace(name="WhatsApp (WAHA)", provider="no-such-driver", status="setup", setup_detail="WAHA does not answer", typeid="data_source-s1", asset_ref="/p/agentic-assets/data_source/waha", setup_skipped=None)]
    running.apps = [SimpleNamespace(id="a1", name="site", asset_ref="/p/site", typeid="micro_app-a1", setup_skipped=None)]

    readiness = await project_setup.readiness_of(project)

    assert not readiness.ready
    left = {(r.kind, r.name): r.note for r in readiness.to_do}
    assert left == {(REQUIREMENT_SOURCE, "WhatsApp (WAHA)"): "WAHA does not answer", (REQUIREMENT_WEBAPP, "site"): "site is not running"}


async def test_an_active_source_and_a_running_site_leave_it_ready(project, running):
    running.sources = [SimpleNamespace(name="feed", provider="no-such-driver", status="active", setup_detail="", typeid="data_source-s2", asset_ref="", setup_skipped=None)]
    running.apps = [SimpleNamespace(id="a1", name="site", asset_ref="/p/site", typeid="micro_app-a1", setup_skipped=None)]
    running.up = {"a1"}

    assert (await project_setup.readiness_of(project)).ready
