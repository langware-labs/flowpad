"""What the bootstrap hands the client as its opening project.

`initSdk` makes `default_project` CURRENT before any route runs, and the app
reads properties off it — it is not just a label to display. A provisioned
sandbox adopts it on its very first load, so anything missing here is missing
at exactly the moment nothing else can supply it.

`locale` was missing, and the failure looked like a timing bug: the box opened
in English while the row said Hebrew, and came right on a refresh — because a
refresh fetches the full entity instead of this payload.
"""

from flow_sdk.builtin.project import Project
from flow_sdk.server.routes.bootstrap import entity_to_dict, project_to_dict


def _project(**fields) -> Project:
    return Project(id="44444444-4444-4444-8444-444444444444", name="opening-project", **fields)


def test_the_opening_project_carries_the_language_it_is_read_in():
    payload = project_to_dict(_project(locale="he"))

    assert payload["locale"] == "he"


def test_a_project_with_no_language_says_so_explicitly():
    """The key is present and null, not absent.

    Absent and "no answer" are the same to the client, but only one of them
    survives a reader asking "did the server tell me?" — and this payload is the
    single source at boot.
    """
    payload = project_to_dict(_project())

    assert "locale" in payload
    assert payload["locale"] is None


def test_the_generic_entity_dict_stays_generic():
    """`entity_to_dict` is the identity projection EVERY entity shares — user,
    domain, visitor, compute node. A project-only field must not leak into it."""
    assert "locale" not in entity_to_dict(_project(locale="he"))


def test_it_is_the_identity_projection_plus_the_project_fields():
    """Whatever the shared projection carries, the project payload still does —
    so a field added there is not silently dropped from the opening project."""
    project = _project(locale="he")

    payload = project_to_dict(project)

    assert set(entity_to_dict(project)).issubset(payload)
