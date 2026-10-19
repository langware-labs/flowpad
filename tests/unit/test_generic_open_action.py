"""One ``GET <type>/<id>/open`` deep-link route for every type (generic-open U3).

The per-type handlers (``flow_message.open``, ``notification.open``) become
``resolve_open`` overrides on their classes behind a single generic ``open``; a
type outside ``OPENABLE_TYPES`` is refused. The message and notification links
are characterized here — their redirects must be exactly what the per-type
handlers produced.

Real request middleware + graph dispatcher; the hub is stubbed at the module
names the handlers call.
"""

from __future__ import annotations

import re
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import pytest

from flow_sdk.actions.action_registry import action
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from tests.unit._graph_client import call_local as _call_local


def _redirect_params(resp) -> dict[str, list[str]]:
    assert resp.status_code == 200, resp.text
    match = re.search(r'url=(http://localhost:\d+/dock/home\?[^"]+)"', resp.text)
    assert match, f"no UI redirect in: {resp.text[:300]}"
    return parse_qs(urlsplit(match.group(1)).query)


@pytest.fixture
def message_hub(monkeypatch):
    """The hub a message deep link talks to: the message, its conversation, no
    further messages to sync, and a join that succeeds."""
    from flow_sdk.app.actions import flow_message_action

    fid, cid = str(uuid4()), str(uuid4())

    async def _hub_get(entity_type, entity_id=None, *args, scope=None, **kwargs):
        et = getattr(entity_type, "value", entity_type)
        if et == BuiltinEntityType.FLOW_MESSAGE.value and entity_id == fid:
            return {
                "id": fid,
                "text": "hi",
                "shared_context_entities": [f"conversation-{cid}"],
                "metadata": {"sender_name": "Dana", "task_title": "Plan"},
            }
        if et == BuiltinEntityType.CONVERSATION.value and entity_id == cid:
            return {"id": cid, "title": "thread"}
        return [] if scope else None

    async def _hub_post(*args, **kwargs):
        return {}

    monkeypatch.setattr(flow_message_action, "hub_get", _hub_get)
    monkeypatch.setattr(flow_message_action, "hub_post", _hub_post)
    return fid, cid


@pytest.mark.asyncio
async def test_a_message_link_redirects_into_its_conversation(message_hub):
    fid, cid = message_hub

    params = _redirect_params(await _call_local("GET", f"flow_message/{fid}/open"))

    assert params == {
        "action": ["open"],
        "fm": [fid],
        "conversation_id": [cid],
        "sender_name": ["Dana"],
        "title": ["Plan"],
    }


@pytest.mark.asyncio
async def test_a_notification_link_redirects_with_its_task(monkeypatch):
    from flow_sdk.app.actions import notification_action

    nid = str(uuid4())

    async def _hub_get(entity_type, entity_id=None, *args, **kwargs):
        return {"metadata": {"task_id": "t-1", "sender_name": "Dana", "task_title": "Fix it"}}

    monkeypatch.setattr(notification_action, "hub_get", _hub_get)

    params = _redirect_params(await _call_local("GET", f"notification/{nid}/open"))

    assert params == {
        "action": ["open"],
        "fm": [nid],
        "task_id": ["t-1"],
        "sender_name": ["Dana"],
        "title": ["Fix it"],
    }


@pytest.mark.asyncio
async def test_a_type_with_no_resolver_cannot_be_opened_from_a_link():
    resp = await _call_local("GET", f"comment/{uuid4()}/open")

    assert resp.status_code == 400, resp.text
    assert "can't be opened from a link" in resp.text


def test_one_generic_open_replaces_the_per_type_ones():
    import flow_sdk.app.actions  # noqa: F401

    for entity_type in ("project", "flow_message", "notification"):
        resolved = action.get_by_name("open", entity_type)
        assert resolved is not None and resolved.action_name == "open", entity_type
    # A type's own open action is untouched (and still wins for that type).
    assert action.get_by_name("open", "agentic_process").action_name == "agentic_process.open"


# -- project: the invite email / hub page "Open in FlowPad" ---------------------


@pytest.fixture
def project_hub(monkeypatch):
    """The hub a project link reads: ``rows`` by id; an int is the HubError status."""
    from flow_sdk.cloud_client.shared.errors import HubError
    from flow_sdk.cloud_client.transport import hub_http

    rows: dict[str, object] = {}

    async def _get_or_raise(entity_type, entity_id=None, *args, **kwargs):
        row = rows.get(entity_id, 404)
        if isinstance(row, int):
            raise HubError(row, f"hub said {row}")
        return row

    monkeypatch.setattr(hub_http, "hub_get_or_raise", _get_or_raise)
    return rows


def _hub_project(pid: str) -> dict:
    return {
        "type": "project",
        "id": pid,
        "name": f"course-{pid[:8]}",
        "git_origin": {
            "kind": "git",
            "rel_path": ".",
            "provider": "github",
            "owner": "langware-labs",
            "name": "course",
            "branch": "main",
        },
    }


@pytest.mark.asyncio
async def test_a_project_link_hydrates_it_and_hands_the_ui_its_set_up(project_hub):
    from flow_sdk.builtin.project import Project

    pid = str(uuid4())
    project_hub[pid] = _hub_project(pid)

    params = _redirect_params(await _call_local("GET", f"project/{pid}/open"))

    assert params["project_id"] == [pid] and params["setup_git"] == ["1"]
    assert '"owner": "langware-labs"' in params["git_origin"][0]
    row = await Project.get_one({"id": pid})
    assert row is not None and row.origin.owner == "langware-labs", "the link mirrors the project before set-up"


@pytest.mark.asyncio
async def test_a_project_installed_here_opens_straight_in(project_hub, tmp_path):
    from flow_sdk.builtin.project import Project

    pid = str(uuid4())
    project_hub[pid] = _hub_project(pid)
    await Project(id=pid, name=f"course-{pid[:8]}", fs_storage_mount_path=str(tmp_path)).save(notify=False)

    params = _redirect_params(await _call_local("GET", f"project/{pid}/open"))

    assert params["project_id"] == [pid]
    assert "setup_git" not in params and "project_error" not in params


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("hub_answer", "error"), [(404, "unavailable"), (403, "unavailable"), (0, "unreachable"), (502, "unreachable")]
)
async def test_a_project_link_says_why_it_cannot_open(project_hub, hub_answer, error):
    pid = str(uuid4())
    project_hub[pid] = hub_answer

    params = _redirect_params(await _call_local("GET", f"project/{pid}/open"))

    assert params["project_id"] == [pid] and params["project_error"] == [error]


# -- project: shared while this desktop had no FlowPad -------------------------


@pytest.fixture
def project_list_hub(monkeypatch):
    """The hub's project list for the signed-in user: ``rows``, signed in."""
    from flow_sdk.cli.auth import hub_login
    from flow_sdk.cloud_client.transport import hub_http

    rows: list[dict] = []

    async def _hub_get(entity_type, entity_id=None, *args, **kwargs):
        assert getattr(entity_type, "value", entity_type) == BuiltinEntityType.PROJECT.value and entity_id is None
        return rows

    monkeypatch.setattr(hub_http, "hub_get", _hub_get)
    monkeypatch.setattr(hub_login, "hub_auth_available", lambda: True)
    return rows


async def _new_cloud_projects() -> list[dict]:
    resp = await _call_local("POST", "new-cloud-projects")
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]["projects"]


@pytest.mark.asyncio
async def test_a_hub_project_this_desktop_never_saw_is_offered_for_set_up(project_list_hub):
    from flow_sdk.builtin.project import Project

    pid = str(uuid4())
    project_list_hub.append(_hub_project(pid))

    [link] = await _new_cloud_projects()

    assert link["project_id"] == pid and link["setup_git"] == "1" and link["title"] == f"course-{pid[:8]}"
    assert '"owner": "langware-labs"' in link["git_origin"]
    row = await Project.get_one({"id": pid})
    assert row is not None and row.remote and not row.fs_storage_mount_path, "mirrored file-less, ready to set up"
    assert await _new_cloud_projects() == [], "offered once: the mirrored row is no longer new"


@pytest.mark.asyncio
async def test_a_hub_project_already_here_or_without_an_origin_is_not_offered(project_list_hub, tmp_path):
    from flow_sdk.builtin.project import Project

    held, no_origin = str(uuid4()), str(uuid4())
    project = Project(id=held, name="mine", fs_storage_mount_path=str(tmp_path))
    await project.save(notify=False)
    project_list_hub.extend([_hub_project(held), {"type": "project", "id": no_origin, "name": "bare"}])

    try:
        assert await _new_cloud_projects() == []
    finally:
        await project.delete()  # project names are unique, and the DB outlives this test


@pytest.mark.asyncio
async def test_signed_out_asks_the_hub_nothing(project_list_hub, monkeypatch):
    from flow_sdk.cli.auth import hub_login

    monkeypatch.setattr(hub_login, "hub_auth_available", lambda: False)
    project_list_hub.append(_hub_project(str(uuid4())))

    assert await _new_cloud_projects() == []


@pytest.mark.asyncio
async def test_a_hub_project_whose_name_is_taken_here_is_offered_with_the_choice(project_list_hub, tmp_path):
    """Its name is already a project here: it is not mirrored, but still offered —
    with that project and a free name, so the set-up can ask (open theirs, or
    install this one under another name). Every other project is offered as usual.
    The sweep used to raise on it — a 500 on every page load, and no offers at all."""
    from flow_sdk.builtin.project import Project

    taken, other = str(uuid4()), str(uuid4())
    clash = _hub_project(taken)
    project = Project(id=str(uuid4()), name=clash["name"], fs_storage_mount_path=str(tmp_path))
    await project.save(notify=False)
    project_list_hub.extend([clash, _hub_project(other)])

    try:
        links = {link["project_id"]: link for link in await _new_cloud_projects()}
        assert set(links) == {taken, other}
        assert links[taken]["existing_project_id"] == project.id
        assert links[taken]["suggested_name"] == f"{clash['name']}-2"
        assert links[taken]["setup_git"] == "1" and '"owner": "langware-labs"' in links[taken]["git_origin"]
        assert "existing_project_id" not in links[other]
        assert await Project.get_one({"id": taken}) is None, "left unmirrored until the receiver chooses"
    finally:
        await project.delete()


@pytest.fixture
def clone_stub(tmp_path, monkeypatch):
    """The clone at the origin driver; the install path above it is real."""
    import flow_sdk.builtin.agentic_process.agentic_process as agentic_process
    from flow_sdk.builtin.drivers.git_driver import GitOriginDriver

    checkout = tmp_path / "checkout"

    async def _materialize(_self, _origin, **_kwargs):
        checkout.mkdir(exist_ok=True)
        return checkout, None

    async def _none(*_args, **_kwargs):
        return None

    monkeypatch.setattr(GitOriginDriver, "materialize", _materialize)
    monkeypatch.setattr(agentic_process, "_index_additional_dir", _none)
    monkeypatch.setattr("flow_sdk.app.actions.oauth_action._get_github_token_for_current_user", _none)
    return checkout


@pytest.mark.asyncio
async def test_a_hub_project_installs_under_the_name_the_receiver_chose(project_hub, clone_stub, tmp_path):
    from flow_sdk.builtin.project import Project

    pid = str(uuid4())
    project_hub[pid] = _hub_project(pid)
    mine = Project(id=str(uuid4()), name=project_hub[pid]["name"], fs_storage_mount_path=str(tmp_path / "mine"))
    await mine.save(notify=False)

    try:
        taken = await _call_local("POST", f"project/{pid}/install-from-hub", json={"name": mine.name})
        assert taken.status_code == 409 and taken.json()["data"]["existing_project_id"] == mine.id

        resp = await _call_local("POST", f"project/{pid}/install-from-hub", json={"name": f"{mine.name}-2"})

        assert resp.status_code == 200, resp.text
        row = await Project.get_one({"id": pid})
        assert row.name == f"{mine.name}-2" and row.origin.owner == "langware-labs"
        assert row.fs_storage_mount_path and row.fs_storage_mount_path.endswith("checkout")
        assert (await Project.get_one({"id": mine.id})).name == mine.name
    finally:
        await mine.delete()
        if row := await Project.get_one({"id": pid}):
            await row.delete()
