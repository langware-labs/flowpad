"""A received message that references a project this box lacks mirrors it (U9).

A project shared with a TEAM reaches its members by a hub group grant: no
invitation whose upsert would mirror the project, and no websocket frame. The
invite message is the first thing the member's client hears, and its Install
chip needs a local Project row. So materializing a hub-origin message fetches
each referenced ``project-<id>`` that is missing locally and mirrors it.

Only the network hop (``FlowpadClient.request``) is stubbed.

# do not increase timeout without approval
"""
from __future__ import annotations

import json
import uuid
from types import SimpleNamespace

import pytest

from flow_sdk.app.actions.materialize_flow_message import materialize_flow_message
from flow_sdk.builtin.project import Project

SENDER = "0a0a0a0a-0000-4000-8000-000000000001"


class _FakeResponse:
    def __init__(self, status_code: int, payload):
        self.status_code = status_code
        self.text = json.dumps(payload)

    def json(self):
        return json.loads(self.text)


@pytest.fixture()
def hub(monkeypatch):
    calls: list[tuple[str, str]] = []
    projects: dict[str, object] = {}

    async def fake_request(self, method, path, **kwargs):
        calls.append((method, path))
        answer = projects.get(path)
        if isinstance(answer, int):
            return _FakeResponse(answer, {"detail": "Forbidden"})
        if isinstance(answer, dict):
            return _FakeResponse(200, {"status": "success", "data": answer})
        return _FakeResponse(404, {"detail": "not found"})

    monkeypatch.setattr(
        "flow_sdk.cli.auth.credentials.load_credentials",
        lambda *a, **k: SimpleNamespace(api_key="test-key", user={"id": "me"}),
    )
    monkeypatch.setattr("flow_sdk.cloud_client.client.ApiConfig.from_env", staticmethod(lambda: None))
    monkeypatch.setattr("flow_sdk.cloud_client.client.FlowpadClient.request", fake_request)
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
    hub.projects[f"/graph/project/{project_id}"] = {
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

    await materialize_flow_message(_message(project.id), str(uuid.uuid4()), someone_typeid=None, remote=True)

    assert [p for _, p in hub.calls if p == f"/graph/project/{project.id}"] == []
    assert (await Project.get_one({"id": project.id})).name == "mine"


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_a_refused_hub_read_creates_no_row(hub):
    project_id = str(uuid.uuid4())
    hub.projects[f"/graph/project/{project_id}"] = 403

    await materialize_flow_message(_message(project_id), str(uuid.uuid4()), someone_typeid=None, remote=True)

    assert await Project.get_one({"id": project_id}) is None


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_a_local_origin_message_does_not_fetch(hub):
    project_id = str(uuid.uuid4())

    await materialize_flow_message(_message(project_id), str(uuid.uuid4()), someone_typeid=None)

    assert hub.calls == []
