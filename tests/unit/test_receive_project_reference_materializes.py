"""A received message that references a project this box lacks mirrors it —
live (``materialize_flow_message``) and on catch-up (``_process_single_hub_message``).

Backward compatibility (FLOWPAD-2199; remove in FLOWPAD-2200): an invite from a
sender without the generic route carries no project in its bundle, and the
invite email's set-up link needs a local Project row. So materializing a
hub-origin message fetches each referenced ``project-<id>`` that is missing
locally and mirrors it.

Only the network hop (``hub_http.hub_get_or_raise``) is stubbed.

# do not increase timeout without approval
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest

from flow_sdk.app.actions.materialize_flow_message import materialize_flow_message
from flow_sdk.builtin.project import Project
from flow_sdk.cloud_client.shared.errors import HubError

SENDER = "0a0a0a0a-0000-4000-8000-000000000001"


@pytest.fixture()
def hub(monkeypatch):
    calls: list[str] = []
    projects: dict[str, object] = {}

    async def fake_hub_get_or_raise(entity_type, entity_id=None, *args, **kwargs):
        calls.append(entity_id)
        answer = projects.get(entity_id)
        if isinstance(answer, dict):
            return answer
        raise HubError(answer if isinstance(answer, int) else 404, "refused")

    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_get_or_raise", fake_hub_get_or_raise)
    return SimpleNamespace(calls=calls, projects=projects)


def _message(project_id: str) -> dict:
    return {
        "id": str(uuid.uuid4()),
        "text": 'I invited you to project "Course".',
        "sender_id": SENDER,
        "sender_name": "Sharer",
        "attachment": [{"attachment_type": "type_id", "data": f"project-{project_id}"}],
    }


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_a_referenced_project_missing_locally_is_mirrored_from_the_hub(hub):
    project_id = str(uuid.uuid4())
    hub.projects[project_id] = {
        "type": "project",
        "id": project_id,
        "name": "Course",
        "origin": {"url": "https://github.com/acme/course.git", "branch": "main"},
    }

    await materialize_flow_message(_message(project_id), str(uuid.uuid4()), someone_typeid=None, remote=True)

    mirrored = await Project.get_one({"id": project_id})
    assert mirrored is not None, "the referenced project was not mirrored"
    assert mirrored.remote is True
    assert mirrored.name == "Course"
    assert mirrored.origin is not None


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_a_project_already_present_is_not_fetched_or_overwritten(hub):
    project = Project(name="mine")
    await project.save()

    try:
        await materialize_flow_message(_message(project.id), str(uuid.uuid4()), someone_typeid=None, remote=True)

        assert project.id not in hub.calls
        assert (await Project.get_one({"id": project.id})).name == "mine"
    finally:
        await project.delete()  # project names are unique, and the DB outlives this test


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_a_refused_hub_read_creates_no_row(hub):
    project_id = str(uuid.uuid4())
    hub.projects[project_id] = 403

    await materialize_flow_message(_message(project_id), str(uuid.uuid4()), someone_typeid=None, remote=True)

    assert await Project.get_one({"id": project_id}) is None


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_an_unreachable_hub_never_fails_the_arrival(hub):
    project_id = str(uuid.uuid4())
    hub.projects[project_id] = 0  # no HTTP response at all

    fm = await materialize_flow_message(_message(project_id), str(uuid.uuid4()), someone_typeid=None, remote=True)

    assert fm is not None
    assert await Project.get_one({"id": project_id}) is None


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_a_local_origin_message_does_not_fetch(hub):
    project_id = str(uuid.uuid4())

    await materialize_flow_message(_message(project_id), str(uuid.uuid4()), someone_typeid=None)

    assert hub.calls == []


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_catch_up_of_a_bundle_less_message_mirrors_its_project(hub):
    from flow_sdk.app.actions.flow_message_action import _process_single_hub_message

    project_id = str(uuid.uuid4())
    name = f"Course-{project_id[:8]}"  # project names are unique per box
    hub.projects[project_id] = {"type": "project", "id": project_id, "name": name}

    assert await _process_single_hub_message(_message(project_id)) is not None

    mirrored = await Project.get_one({"id": project_id})
    assert mirrored is not None, "catch-up did not mirror the referenced project"
    assert mirrored.name == name
