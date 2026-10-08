"""A connection's setup stages, as they stand for one thing it sets up.

Nothing is stored: a stage is read off its wizard's last run FOR that thing. So the record a run
writes is the only record, and a second target of the same wizard is a different answer.
"""

from __future__ import annotations

import uuid

import pytest
from pydantic import ValidationError

from flow_sdk.core.wizard import state as wizard_state
from flow_sdk.core.wizard.stages import stage_states
from flow_sdk.schema.data_spec.credential_spec import CredentialSpec
from flow_sdk.schema.data_spec.data_driver_spec import DataDriverSpec
from flow_sdk.schema.data_spec.returned_value_spec import WizardResult
from flow_sdk.schema.data_spec.setup_stage_spec import SetupStageSpec

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval

STAGES = [SetupStageSpec(stage="test", wizard="wa-test"), SetupStageSpec(stage="production", wizard="wa-prod")]


class _Row:
    def __init__(self, name: str) -> None:
        self.id = uuid.uuid5(uuid.NAMESPACE_URL, name)


@pytest.fixture
def wizards(tmp_path, monkeypatch):
    from flow_sdk.builtin import wizard as wizard_module

    monkeypatch.setattr(wizard_state, "run_dir", lambda key: tmp_path / "runs" / key)
    rows = {"wa-test": _Row("wa-test"), "wa-prod": _Row("wa-prod")}

    async def by_name(name):
        return rows.get(name)

    monkeypatch.setattr(wizard_module.Wizard, "by_name", staticmethod(by_name))
    return rows


def _record(rows, wizard: str, target: str, result: WizardResult) -> None:
    wizard_state.record_result(wizard_state.run_key(str(rows[wizard].id), target), result)


async def test_nothing_run_is_test_pending_and_production_locked(wizards):
    states = await stage_states(STAGES, "data_source:a")
    assert [(s.stage, s.state) for s in states] == [("test", "pending"), ("production", "locked")]
    assert states[0].label == "Test"


async def test_a_finished_test_stage_unlocks_production_for_that_target_only(wizards):
    _record(wizards, "wa-test", "data_source:a", WizardResult.satisfied("talking to +1 555"))

    mine = await stage_states(STAGES, "data_source:a")
    assert [(s.state, s.detail) for s in mine] == [("done", "talking to +1 555"), ("pending", "")]
    other = await stage_states(STAGES, "data_source:b")
    assert [s.state for s in other] == ["pending", "locked"], "another channel of the same driver is its own run"


async def test_a_run_that_stopped_short_stays_pending_with_its_sentence(wizards):
    _record(wizards, "wa-test", "data_source:a", WizardResult.not_yet("Meta webhook: not subscribed yet"))
    (test, production) = await stage_states(STAGES, "data_source:a")
    assert (test.state, test.detail) == ("pending", "Meta webhook: not subscribed yet")
    assert production.state == "locked"


async def test_a_stage_naming_no_installed_wizard_says_so(wizards):
    (missing,) = await stage_states([SetupStageSpec(stage="x", wizard="nope")], "data_source:a")
    assert missing.state == "pending" and "no wizard named 'nope'" in missing.detail


def test_a_stage_is_declared_once():
    """Both declaring specs share the rule: a credential can be parsed whole, so it proves the wiring."""
    body = {
        "name": "whatsapp",
        "schema": 2,
        "setup": "x",
        "setup_wizards": [
            {"stage": "test", "wizard": "a"},
            {"stage": "test", "wizard": "b"},
        ],
    }
    with pytest.raises(ValidationError, match="declared twice"):
        CredentialSpec.model_validate(body)
    assert "setup_wizards" in DataDriverSpec.model_fields


async def test_a_source_found_not_set_up_has_its_last_stage_pending_again(wizards, monkeypatch):
    """How far setup got is the wizard's record; whether it still holds is the row's. A source its verify found not set
    up (status ``setup``) reopens the stage that proves it, saying why — every other source reads its history."""
    from flow_sdk.builtin import readiness
    from flow_sdk.builtin.data_source import DataSource, SourceStatus

    async def driver_of(provider):
        return type("Driver", (), {"setup_wizards": STAGES})

    monkeypatch.setattr(readiness, "driver_of", driver_of)
    source = DataSource(provider="whatsapp", name="wa")
    for wizard in ("wa-test", "wa-prod"):
        _record(wizards, wizard, str(source.typeid), WizardResult.satisfied("done"))
    assert [s.state for s in await source.setup_stages()] == ["done", "done"]

    source.status, source.setup_detail = SourceStatus.SETUP.value, "Press Connect WhatsApp first."
    (test, production) = await source.setup_stages()
    assert test.state == "done" and (production.state, production.detail) == ("pending", "Press Connect WhatsApp first.")
