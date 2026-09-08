"""``WizardSpec`` — the shape of ``wizard.json``, and its registration.

The registration assertions are the point of this file. A ``spec_kind`` that is
unreachable from ``register_builtin_kinds()`` resolves to ``Any``: legal,
opaque, and never minted. Nothing raises, nothing logs, and the field silently
stops being typed — so the only thing standing between a forgotten import line
and an untyped wizard document is a test that asks.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.data_spec._kinds import register_builtin_kinds
from flow_sdk.schema.data_spec.wizard_spec import (
    WizardCheckSpec,
    WizardCommandActionSpec,
    WizardProcessActionSpec,
    WizardSpec,
    WizardStepSpec,
    WizardTriggerSpec,
)

pytestmark = pytest.mark.timeout(5)


def _step(**over) -> dict:
    base = {"id": "s1", "label": "One", "process": {"prompt": "do it"}}
    base.update(over)
    return base


@pytest.mark.parametrize(
    "kind,cls",
    [
        ("wizard", WizardSpec),
        ("wizard.step", WizardStepSpec),
        ("wizard.check", WizardCheckSpec),
        ("wizard.trigger", WizardTriggerSpec),
        ("wizard.action.command", WizardCommandActionSpec),
        ("wizard.action.process", WizardProcessActionSpec),
    ],
)
def test_every_kind_is_reachable_from_register_builtin_kinds(kind, cls):
    register_builtin_kinds()
    assert SchemaRegistry.kind_type(kind) is cls, (
        f"{kind!r} is not registered — add the wizard_spec import to "
        "register_builtin_kinds(); an unreachable kind resolves to Any SILENTLY"
    )


def test_per_os_command_map_is_expressible_only_because_the_class_is_registered():
    """The authoring form has no map type. ``to_authoring_form`` short-circuits
    on ``spec_kind`` before it would reach the dict and fail — which is why the
    per-OS table has to live on a registered class."""
    from flow_sdk.schema.data_spec.spec import to_authoring_form

    register_builtin_kinds()
    assert to_authoring_form(WizardCheckSpec) == "wizard.check"


def test_extra_keys_are_refused_so_a_typo_is_not_an_empty_field():
    with pytest.raises(ValidationError):
        WizardCheckSpec(commands={"linux": "x"}, timout_seconds=5)  # noqa: typo on purpose


def test_specs_are_frozen_values():
    check = WizardCheckSpec(commands={"linux": "x"})
    with pytest.raises(ValidationError):
        check.timeout_seconds = 99


def test_commands_survive_a_dump_validate_round_trip():
    spec = WizardSpec.model_validate({"name": "w", "steps": [_step(
        precondition={"commands": {"linux": "a", "win32": "b"}},
    )]})
    again = WizardSpec.model_validate(spec.model_dump())
    assert again.steps[0].precondition.commands == {"linux": "a", "win32": "b"}


def test_a_step_needs_exactly_one_action():
    with pytest.raises(ValidationError, match="exactly one"):
        WizardStepSpec.model_validate({"id": "s"})
    with pytest.raises(ValidationError, match="exactly one"):
        WizardStepSpec.model_validate(
            {"id": "s", "command": {"commands": {"linux": "x"}}, "process": {"prompt": "p"}}
        )


def test_on_fail_is_closed():
    with pytest.raises(ValidationError, match="on_fail"):
        WizardStepSpec.model_validate(_step(on_fail="explode"))


def test_display_label_falls_back_to_the_id():
    assert WizardStepSpec.model_validate(_step(label="")).display_label == "s1"


def test_a_wizard_declares_its_own_triggers():
    spec = WizardSpec.model_validate(
        {"name": "w", "triggers": [{"on": "app.ready", "fire_once": True}], "steps": [_step()]}
    )
    assert [(t.on, t.fire_once) for t in spec.triggers] == [("app.ready", True)]


def test_the_run_payloads_are_registered_data_specs():
    """A shape that travels is a `DataSpec`, per the repo's one-type-system rule.

    These three do travel: into `run.json`, onto the entity payload as
    `Wizard.run_state`, and out to the TS mirror. They were hand-written
    `to_payload()` dicts — no validation on the way back in, no JSON Schema, and
    no name in the tag ontology. Registration is import-time and fails SILENTLY
    (an unreachable kind resolves to `Any`), so the reachability is asserted too.
    """
    from flow_sdk.schema.data_spec._kinds import resolve_kind
    from flow_sdk.schema.data_spec.wizard_spec import (
        WizardAwaitingInputSpec,
        WizardStepOutcomeSpec,
    )

    for kind in ("wizard.outcome", "wizard.awaiting"):
        assert resolve_kind(kind) is not None, (
            f"{kind} is not reachable from register_builtin_kinds() — an "
            "unregistered kind is legal, opaque and never minted, with no error "
            "anywhere to say so"
        )

    # `extra="forbid"` is the point of the rule: a misspelled key must be an
    # error, not a row with an empty field.
    with pytest.raises(Exception):
        WizardStepOutcomeSpec(step_id="a", status="completed", mesage="typo")
    with pytest.raises(Exception):
        WizardAwaitingInputSpec(name="marker", labl="typo")
