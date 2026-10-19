"""``ProjectSubkind`` — what a project is FOR, declared in its manifest so a clone knows
before anything opens: a ``controller`` asks for a target first."""
from __future__ import annotations

import inspect
import json

import pytest
from pydantic import ValidationError

from flow_sdk.builtin.project import Project
from flow_sdk.schema.data_spec.project_manifest_spec import ProjectManifestSpec, ProjectSubkind

pytestmark = pytest.mark.timeout(5)  # do not increase without approval


def test_standard_is_the_silent_default():
    spec = ProjectManifestSpec.model_validate({})
    assert spec.subkind is ProjectSubkind.STANDARD
    # An older desk reads the file with extra="forbid": a standard project writes no key.
    assert "subkind" not in spec.to_document()


@pytest.mark.parametrize("value", ["controller", "addon"])
def test_a_declared_subkind_round_trips(value):
    document = ProjectManifestSpec.model_validate({"subkind": value}).to_document()
    assert document["subkind"] == value
    assert json.loads(json.dumps(document))["subkind"] == value
    assert ProjectManifestSpec.model_validate(document).subkind == value


def test_an_unknown_subkind_is_refused():
    with pytest.raises(ValidationError):
        ProjectManifestSpec.model_validate({"subkind": "sidecar"})


def test_a_help_desk_is_adopted_as_an_optional_dependency_by_default():
    # A help desk portal is an addon: the host works without it.
    assert inspect.signature(Project.adopt_helpdesk_from_git).parameters["optional"].default is True
