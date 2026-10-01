"""A credential variable's ``required`` is ``MUST`` | ``OPTIONAL``.

It was a bool. As a string enum, ``"OPTIONAL"`` is truthy — so the risk is not the
field but every reader that used to write ``if var.required``. These pin the
contract (default, legacy bools, junk) and the readers that decide what a
credential needs.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from flow_sdk.builtin.credential import Credential
from flow_sdk.schema.data_spec.credential_contract import CredentialRequirement
from flow_sdk.schema.data_spec.credential_spec import CredentialSpec, CredentialVarSpec
from flow_sdk.schema.data_spec.credential_status_spec import CredentialVarStatusSpec

MUST, OPTIONAL = CredentialRequirement.MUST, CredentialRequirement.OPTIONAL


def test_an_unmarked_variable_is_a_must():
    assert CredentialVarSpec().required is MUST


@pytest.mark.parametrize(
    ("written", "reads"),
    [(True, MUST), (False, OPTIONAL), ("MUST", MUST), ("OPTIONAL", OPTIONAL), ("optional", OPTIONAL)],
)
def test_required_reads_the_enum_and_a_pre_enum_bool(written, reads):
    assert CredentialVarSpec(required=written).required is reads
    assert CredentialVarStatusSpec(env_var="X", required=written).required is reads


def test_anything_else_is_refused():
    with pytest.raises(ValidationError):
        CredentialVarSpec(required="maybe")


def test_the_manifest_writes_the_enum_word():
    spec = CredentialSpec(schema=2, name="stripe", setup="…", vars={"K": {"required": False}, "S": {}})
    written = spec.model_dump(mode="json")["vars"]
    assert (written["K"]["required"], written["S"]["required"]) == ("OPTIONAL", "MUST")


def test_an_optional_variable_is_not_among_the_required():
    # The truthiness trap: ``"OPTIONAL"`` is a non-empty string.
    row = Credential(name="stripe", vars={"KEY": {"required": "MUST"}, "HOOK": {"required": "OPTIONAL"}})
    assert row.required_var_names() == ["KEY"]
