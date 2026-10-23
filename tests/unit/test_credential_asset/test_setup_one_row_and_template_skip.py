"""One row per need, and a shipped template this project does not declare yet can still be skipped here.

A data source waiting on a credential is that credential's row ("Used by: <source>"), not a second row;
a template's skip lives in the project's own map — its record is every project's, a mark there would
skip it everywhere."""
from __future__ import annotations

import pytest

from flow_sdk.builtin import project_setup
from flow_sdk.schema.data_spec.project_setup_spec import (
    REQUIREMENT_PACK,
    REQUIREMENT_SOURCE,
    REQUIREMENT_WEBAPP,
    RootRef,
    SetupRequirementSpec,
    SetupVarSpec,
)

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

TEMPLATE_TYPEID = "credential-b39e78ba-47ef-4d31-8fe9-b9c55f7eb2cd"
MISSING = [SetupVarSpec(env_var="GMAIL_ADDRESS", secret=False)]


def _source(name: str) -> SetupRequirementSpec:
    return SetupRequirementSpec(kind=REQUIREMENT_SOURCE, name=name, typeid=f"data_source-{name}", satisfied=False)


def _pack(*, used_by: list[str], vars=MISSING, declared: bool = True) -> SetupRequirementSpec:
    roots = [RootRef(typeid=f"data_source-{name}", kind="data_source", name=name) for name in used_by]
    return SetupRequirementSpec(kind=REQUIREMENT_PACK, name="gmail", typeid=TEMPLATE_TYPEID, used_by=used_by,
                                roots=roots, vars=list(vars), declared=declared)


async def test_a_source_waiting_on_a_listed_credential_is_folded_into_its_row():
    app = SetupRequirementSpec(kind=REQUIREMENT_WEBAPP, name="site", typeid="micro_app-x", satisfied=False)
    kept = project_setup._beyond_credentials([_source("Gmail"), _source("Feed"), app], [_pack(used_by=["Gmail"])])
    assert [r.name for r in kept] == ["Feed", "site"]


async def test_a_source_shows_again_once_its_credential_is_set_up():
    held = _pack(used_by=["Gmail"], vars=[SetupVarSpec(env_var="GMAIL_ADDRESS", present=True)])
    assert [r.name for r in project_setup._beyond_credentials([_source("Gmail")], [held])] == ["Gmail"]


async def test_skipping_an_undeclared_template_marks_this_project_not_the_template(project, monkeypatch):
    template_req = _pack(used_by=["Gmail"], declared=False)

    async def listed(_project, *_a, **_k):
        return [template_req]

    async def nothing_running(_project, *_a):
        return []

    async def no_record(_req):
        raise AssertionError("a template's own record is every project's: never marked")

    monkeypatch.setattr(project_setup, "collect_requirements", listed)
    monkeypatch.setattr(project_setup, "_running_here", nothing_running)
    monkeypatch.setattr(project_setup, "_record_of", no_record)

    await project_setup.skip_requirement(project, TEMPLATE_TYPEID, scope="local", note="not here")
    mark = (project.setup_skipped or {})["credential:gmail"]
    assert mark.note == "not here"

    await project_setup.unskip_requirement(project, TEMPLATE_TYPEID)
    assert "credential:gmail" not in (project.setup_skipped or {})


async def test_a_setup_question_skips_the_step_that_asked(project, monkeypatch):
    """The question's own Skip is the row's local skip, of the step stamped on the question."""
    from flow_sdk.builtin.project import Project
    from flow_sdk.core.setup.walk import SetupControl

    source, template_req = _source("Gmail"), _pack(used_by=["Gmail"], declared=False)

    async def listed(_project, *_a, **_k):
        return [source, template_req]

    async def nothing_running(_project, *_a):
        return []

    async def this_project(_query):
        return project

    monkeypatch.setattr(project_setup, "collect_requirements", listed)
    monkeypatch.setattr(project_setup, "_running_here", nothing_running)
    monkeypatch.setattr(Project, "get_one", this_project)
    control = SetupControl()
    monkeypatch.setitem(project_setup._CONTROLS, (str(project.id), ""), control)
    run = project_setup.setup_run_address(str(project.id))

    assert not await project_setup.skip_asking("setup-somebody-else", "credential:gmail")
    assert await project_setup.skip_asking(run, "credential:gmail")
    assert "credential:gmail" in (project.setup_skipped or {})
    assert "credential:gmail" in control.skips and source.typeid not in control.skips


async def test_only_a_question_a_setup_step_asked_offers_skip_and_cards_carry_no_guide():
    from flow_sdk.core.compute_op.ask import ASKING_STEP, Question, forget, open_question
    from flow_sdk.schema.data_spec.compute_op_spec import AskChoiceSpec

    assert Question(id="q", op_name="op", prompt="?", shape="string").to_payload()["skippable"] is False
    token = ASKING_STEP.set("credential:gmail")
    try:
        asked = open_question("op", "?", "string", guide="run `flow credentials set`",
                              choices=[AskChoiceSpec(value="google", label="Google")])
    finally:
        ASKING_STEP.reset(token)
    payload = asked.to_payload()
    forget(asked.id)
    assert payload["skippable"] is True and payload["guide"] == ""
