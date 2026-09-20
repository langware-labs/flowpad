"""``WizardSpec`` — the shape of ``wizard.json``, and its registration.

The registration assertions are the point of this file. A ``spec_kind`` that is
unreachable from ``register_builtin_kinds()`` resolves to ``Any``: legal,
opaque, and never minted. Nothing raises, nothing logs, and the field silently
stops being typed — so the only thing standing between a forgotten import line
and an untyped wizard document is a test that asks.

A step is now a CALL — ``kind`` / ``ref`` / ``args``. The per-OS command tables,
the check and the agent moved into ComputeOp, and are tested there.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.data_spec._kinds import register_builtin_kinds
from flow_sdk.schema.data_spec.wizard_spec import (
    InputSpec,
    StepKind,
    WizardSpec,
    WizardStepSpec,
)

pytestmark = pytest.mark.timeout(5)


def _step(**over) -> dict:
    base = {"id": "s1", "label": "One", "kind": "compute", "ref": "jq-on-path"}
    base.update(over)
    return base


@pytest.mark.parametrize(
    "kind,cls",
    [
        ("wizard", WizardSpec),
        ("wizard.step", WizardStepSpec),
        ("wizard.input", InputSpec),
    ],
)
def test_every_kind_is_reachable_from_register_builtin_kinds(kind, cls):
    register_builtin_kinds()
    assert SchemaRegistry.kind_type(kind) is cls, (
        f"{kind!r} is not registered — add the wizard_spec import to "
        "register_builtin_kinds(); an unreachable kind resolves to Any SILENTLY"
    )


def test_the_args_map_is_expressible_only_because_the_class_is_registered():
    """The authoring form has no map type. ``to_authoring_form`` short-circuits
    on ``spec_kind`` before it would reach the dict and fail — which is why a
    step carrying an ``args`` table has to live on a registered class."""
    from flow_sdk.schema.data_spec.spec import to_authoring_form

    register_builtin_kinds()
    assert to_authoring_form(WizardStepSpec) == "wizard.step"


def test_extra_keys_are_refused_so_a_typo_is_not_an_empty_field():
    with pytest.raises(ValidationError):
        WizardStepSpec.model_validate(_step(reff="jq"))  # noqa: typo on purpose


def test_specs_are_frozen_values():
    step = WizardStepSpec.model_validate(_step())
    with pytest.raises(ValidationError):
        step.ref = "something-else"


def test_args_survive_a_dump_validate_round_trip():
    spec = WizardSpec.model_validate({"name": "w", "steps": [
        _step(args={"API_KEY": "WAHA_API_KEY", "PORT": "3010"}),
    ]})
    again = WizardSpec.model_validate(spec.model_dump())
    assert again.steps[0].args == {"API_KEY": "WAHA_API_KEY", "PORT": "3010"}


def test_a_step_must_name_what_it_calls():
    with pytest.raises(ValidationError):
        WizardStepSpec.model_validate({"id": "s", "kind": "compute"})


def test_kind_is_closed():
    with pytest.raises(ValidationError):
        WizardStepSpec.model_validate(_step(kind="sorcery"))


def test_on_fail_is_closed():
    with pytest.raises(ValidationError, match="on_fail"):
        WizardStepSpec.model_validate(_step(on_fail="explode"))


def test_display_label_falls_back_to_the_id():
    assert WizardStepSpec.model_validate(_step(label="")).display_label == "s1"


def test_an_ask_step_must_name_a_declared_input():
    """A question nobody can answer parks the run forever, so it is a parse error.

    The value a person gives is stored under the wizard's parameter name; a step
    asking for a name the wizard never declared would park, be answered, and
    park again on the next run.
    """
    with pytest.raises(ValidationError, match="inputs"):
        WizardSpec.model_validate({"name": "w", "steps": [
            {"id": "ask", "kind": "ask", "ref": "TOKEN"},
        ]})

    ok = WizardSpec.model_validate({
        "name": "w",
        "inputs": {"TOKEN": {"shape": "string", "label": "Token"}},
        "steps": [{"id": "ask", "kind": "ask", "ref": "TOKEN"}],
    })
    assert ok.inputs["TOKEN"].label == "Token"


def test_an_ask_step_takes_no_args():
    """`args` binds a CALLEE's parameters. A person is not a callee with a
    signature — the value goes to this wizard's own input, by name."""
    with pytest.raises(ValidationError, match="no args"):
        WizardSpec.model_validate({
            "name": "w", "inputs": {"TOKEN": {}},
            "steps": [{"id": "ask", "kind": "ask", "ref": "TOKEN", "args": {"x": "y"}}],
        })


def test_a_wizard_is_either_a_conversation_or_a_sequence():
    with pytest.raises(ValidationError, match="either"):
        WizardSpec.model_validate({"name": "w", "agent": "someone", "steps": [_step()]})
    with pytest.raises(ValidationError, match="neither"):
        WizardSpec.model_validate({"name": "w"})


def test_an_inline_triggers_array_is_refused():
    """A wizard's trigger is a child asset now, and there is exactly one way to
    declare one. A document still carrying the old array must fail LOUDLY —
    silently ignoring it would leave the author with a wizard that never runs
    and nothing anywhere saying why."""
    with pytest.raises(ValueError, match="triggers"):
        WizardSpec.model_validate(
            {"name": "w", "triggers": [{"on": "app.ready", "fire_once": True}], "steps": [_step()]}
        )


def test_the_run_payloads_are_registered_data_specs():
    """A shape that travels is a `DataSpec`, per the repo's one-type-system rule.

    These do travel: into `run.json`, onto the entity payload as
    `Wizard.run_state`, and out to the TS mirror. Registration is import-time and
    fails SILENTLY (an unreachable kind resolves to `Any`), so the reachability
    is asserted too.
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


def test_the_step_kinds_are_the_three_things_a_wizard_can_call():
    # An agent is NOT a kind: an agent run is a ComputeOp, so a step that wants
    # one references that op — which makes the agent's work checkable and reusable.
    assert {k.value for k in StepKind} == {"compute", "wizard", "ask"}
