"""``Project.share`` invites people and grants teams, and writes every invite conversation itself.

A PERSON gets one project invite whose second target is a fresh 1:1 invite
conversation the sharer's client opened, then the invite message in it (KTD3,
R6). A TEAM is granted on the hub as ONE group principal — never expanded into
its people — and gets one invite conversation granted to the whole team (KTD1,
R1, R7). The sharer, anyone already on the roster and any team already granted
are skipped (KTD6, R3), and each recipient's outcome is collected rather than one
failure stopping the rest (KTD7, R11). The hub's ``notify_by_message`` is never
sent: the message moved to the client.

Only the network hops are stubbed: ``FlowpadClient.request`` and
``flow_sdk.utils.hub.hub_post`` (the message body upload).
"""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from flow_sdk.builtin.project import Project
from flow_sdk.schema.data_spec.share_request_spec import ShareInvitee

SHARER = "0a0a0a0a-0000-4000-8000-000000000001"
ISHAY = "1b1b1b1b-0000-4000-8000-000000000002"
DANA = "2c2c2c2c-0000-4000-8000-000000000003"
MIA = "4e4e4e4e-0000-4000-8000-000000000005"
PENDING = "5f5f5f5f-0000-4000-8000-000000000006"
ZSCHOOL = "6a6a6a6a-0000-4000-8000-000000000007"
LOCKED = "8c8c8c8c-0000-4000-8000-000000000009"


class _FakeResponse:
    def __init__(self, status_code: int, payload):
        self.status_code = status_code
        self.text = payload if isinstance(payload, str) else json.dumps(payload)

    def json(self):
        return json.loads(self.text)


def _ok(data) -> _FakeResponse:
    return _FakeResponse(200, {"status": "success", "data": data})


def _user(user_id: str, *, email: str | None = None, status: str = "approved", name: str = "Someone") -> dict:
    return {"type": "user", "user_id": user_id, "user_email": email, "user_name": name, "role": "member", "status": status}


def _team(team_id: str, name: str = "A team") -> dict:
    return {"type": "team", "id": team_id, "user_id": None, "name": name, "role": "member", "status": "approved"}


class _Hub(list):
    """Every hub call as ``(method, path, json_body)``, plus the per-test answers.

    ``rosters`` maps a members path to its rows (or an int status to refuse);
    ``answers`` maps a recipient key (user id, email or team typeid) to an int
    status for a refused members POST; ``refuse`` maps a path suffix to the
    status every call ending in it answers with.
    """

    rosters: dict
    answers: dict
    refuse: dict


@pytest.fixture()
def hub(monkeypatch):
    calls = _Hub()
    calls.rosters = {}
    calls.answers = {}
    calls.refuse = {}

    async def fake_request(self, method, path, **kwargs):
        body = kwargs.get("json")
        calls.append((method, path, body))
        for suffix, status in calls.refuse.items():
            if path.rstrip("/").endswith(suffix):
                return _FakeResponse(status, {"detail": "refused"})
        if method == "GET":
            rows = calls.rosters.get(path, [])
            if isinstance(rows, int):
                return _FakeResponse(rows, {"detail": "Forbidden"})
            return _ok(rows)
        if path.endswith("/members") and isinstance(body, dict):
            key = body.get("recipient_user_id") or body.get("recipient_email") or body.get("principal")
            answer = calls.answers.get(key)
            if isinstance(answer, int):
                return _FakeResponse(answer, {"detail": "boom"})
        return _ok({})

    async def fake_hub_post(entity_type, data, *path_parts, action=None, **_kwargs):
        calls.append(("HUB_POST", action or "/".join(str(p) for p in path_parts[1:]), data))
        return {}

    monkeypatch.setattr(
        "flow_sdk.cli.auth.credentials.load_credentials",
        lambda *a, **k: SimpleNamespace(api_key="test-key", user={"id": SHARER, "email": "sharer@example.com"}),
    )
    monkeypatch.setattr("flow_sdk.cloud_client.client.ApiConfig.from_env", staticmethod(lambda: None))
    monkeypatch.setattr("flow_sdk.cloud_client.client.FlowpadClient.request", fake_request)
    monkeypatch.setattr("flow_sdk.utils.hub.hub_post", fake_hub_post)
    return calls


def _project(hub: _Hub, name: str, roster: list[dict] | None = None) -> Project:
    proj = Project(name=name)
    hub.rosters[f"/graph/project/{proj.id}/members"] = roster if roster is not None else [
        _user(SHARER, email="sharer@example.com", name="Sharer") | {"role": "owner"}
    ]
    return proj


def _project_posts(hub: _Hub, proj: Project) -> list[dict]:
    return [body for method, path, body in hub if method == "POST" and path == f"/graph/project/{proj.id}/members"]


def _person_invites(hub: _Hub, proj: Project) -> list[dict]:
    return [b for b in _project_posts(hub, proj) if "principal" not in b]


def _group_grants(hub: _Hub, proj: Project) -> list[dict]:
    return [b for b in _project_posts(hub, proj) if "principal" in b]


def _invited_keys(hub: _Hub, proj: Project) -> list[str]:
    return sorted(b.get("recipient_user_id") or b.get("recipient_email") for b in _person_invites(hub, proj))


def _conversation_grants(hub: _Hub) -> list[tuple[str, dict]]:
    return [
        (path, body)
        for method, path, body in hub
        if method == "POST" and path.startswith("/graph/conversation/") and path.endswith("/members")
    ]


def _conversation_creates(hub: _Hub) -> list[str]:
    return [path for method, path, _ in hub if method == "POST" and path.rstrip("/").endswith("/graph/conversation")]


def _message_headers(hub: _Hub) -> list[dict]:
    return [body for method, path, body in hub if method == "POST" and path.rstrip("/").endswith("/add_message")]


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_person_invite_carries_the_conversation_and_a_team_is_one_group_grant(hub):
    """R1/R6/R7: a person gets [project, conversation] targets and no hub
    ``notify_by_message``; a team is ONE group grant plus a conversation granted
    to it; nobody reads the team's member list."""
    proj = _project(hub, "share-person-and-team")

    await proj.share(invitees=[ShareInvitee(user_id=ISHAY)], teams=[f"team-{ZSCHOOL}"], note="Welcome aboard")

    (person,) = _person_invites(hub, proj)
    assert person["recipient_user_id"] == ISHAY
    assert "notify_by_message" not in person
    assert person["message"] == "Welcome aboard"
    project_target, conversation_target = person["invitation_targets"]
    assert project_target == {"typeid": f"project-{proj.id}", "role": "member"}
    assert conversation_target["typeid"].startswith("conversation-") and conversation_target["role"] == "member"

    assert _group_grants(hub, proj) == [
        {"principal": f"team-{ZSCHOOL}", "invitation_targets": [{"typeid": f"project-{proj.id}", "role": "member"}]}
    ]
    ((path, team_conv_grant),) = _conversation_grants(hub)
    assert team_conv_grant["principal"] == f"team-{ZSCHOOL}"
    assert path == f"/graph/conversation/{team_conv_grant['invitation_targets'][0]['typeid'][len('conversation-'):]}/members"

    assert not [p for m, p, _ in hub if m == "GET" and p.startswith("/graph/team/")]
    assert len(_conversation_creates(hub)) == 2
    assert len(_message_headers(hub)) == 2

    result = proj.last_share_result
    assert [r.user_id for r in result.invited] == [ISHAY]
    assert result.invited[0].conversation_id == conversation_target["typeid"][len("conversation-"):]
    assert [(t.team, t.conversation_id is not None) for t in result.granted_teams] == [(f"team-{ZSCHOOL}", True)]
    assert result.skipped_teams == [] and result.failed_teams == [] and result.failed == []


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_the_invite_message_carries_the_project_reference_and_the_note(hub):
    proj = _project(hub, "Course Project")

    await proj.share(invitees=[ShareInvitee(user_id=ISHAY)], note="See you there")

    (header,) = _message_headers(hub)
    assert header["text"] == 'I invited you to project "Course Project".\n\nSee you there'
    assert f"project-{proj.id}" in [a.get("data") for a in header["attachment"]]
    assert [p for m, p, _ in hub if m == "HUB_POST"] == ["fs/upload", "set_body_status"]


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_a_team_already_on_the_roster_is_skipped_without_any_call(hub):
    """R3/KTD6: a team already granted gets no second grant, conversation or message."""
    proj = _project(
        hub,
        "share-team-already-granted",
        roster=[_user(SHARER, email="sharer@example.com") | {"role": "owner"}, _team(ZSCHOOL, "zschool")],
    )

    await proj.share(teams=[f"team-{ZSCHOOL}"])

    assert _group_grants(hub, proj) == [] and _conversation_creates(hub) == []
    result = proj.last_share_result
    assert [(t.team, t.name, t.reason) for t in result.skipped_teams] == [(f"team-{ZSCHOOL}", "zschool", "already_granted")]
    assert result.granted_teams == []


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_a_refused_group_grant_fails_the_team_and_opens_no_conversation(hub):
    proj = _project(hub, "share-team-refused")
    hub.answers[f"team-{LOCKED}"] = 403

    await proj.share(teams=[f"team-{LOCKED}"])

    assert _conversation_creates(hub) == []
    result = proj.last_share_result
    assert [(t.team, t.status) for t in result.failed_teams] == [(f"team-{LOCKED}", 403)]
    assert result.granted_teams == []


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_a_granted_team_whose_conversation_fails_is_granted_without_a_conversation(hub):
    proj = _project(hub, "share-team-no-conversation")
    hub.refuse["/graph/conversation"] = 500

    await proj.share(teams=[f"team-{ZSCHOOL}"])

    assert len(_group_grants(hub, proj)) == 1
    result = proj.last_share_result
    assert [(t.team, t.conversation_id) for t in result.granted_teams] == [(f"team-{ZSCHOOL}", None)]
    assert result.failed_teams == []


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_a_refused_person_invite_is_failed_and_its_conversation_discarded(hub):
    proj = _project(hub, "share-person-refused")
    hub.answers[ISHAY] = 403

    await proj.share(invitees=[ShareInvitee(user_id=ISHAY)])

    result = proj.last_share_result
    assert [(r.user_id, r.status) for r in result.failed] == [(ISHAY, 403)]
    assert result.invited == []
    deletes = [p for m, p, _ in hub if m == "DELETE"]
    assert len(deletes) == 1 and deletes[0].startswith("/graph/conversation/")
    assert _message_headers(hub) == []


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_a_person_whose_message_fails_is_still_invited_with_the_conversation(hub):
    proj = _project(hub, "share-person-message-fails")
    hub.refuse["/add_message"] = 500

    await proj.share(invitees=[ShareInvitee(user_id=ISHAY)])

    result = proj.last_share_result
    assert [r.user_id for r in result.invited] == [ISHAY]
    assert result.invited[0].conversation_id
    assert result.failed == []


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_sharer_member_pending_and_team_covered_people_are_skipped(hub):
    """The sharer, a direct member, a pending invitee and a person who reaches
    the project through a granted team (listed as an ordinary user row) are all
    skipped; only the new person is invited."""
    proj = _project(
        hub,
        "share-skips",
        roster=[
            _user(SHARER, email="sharer@example.com") | {"role": "owner"},
            _user(DANA),
            _user(PENDING, status="pending"),
            _team(ZSCHOOL),
            _user(MIA),  # reaches the project through zschool
        ],
    )

    await proj.share(
        invitees=[
            ShareInvitee(user_id=SHARER),
            ShareInvitee(user_id=DANA),
            ShareInvitee(user_id=PENDING),
            ShareInvitee(user_id=MIA),
            ShareInvitee(user_id=ISHAY),
        ]
    )

    assert _invited_keys(hub, proj) == [ISHAY]
    reasons = {r.user_id: r.reason for r in proj.last_share_result.skipped}
    assert reasons == {SHARER: "self", DANA: "already_member", PENDING: "already_invited", MIA: "already_member"}


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_sharer_is_dropped_even_when_the_project_roster_is_unreadable(hub):
    proj = _project(hub, "share-roster-down")
    hub.rosters[f"/graph/project/{proj.id}/members"] = 503

    await proj.share(invitees=[ShareInvitee(user_id=SHARER), ShareInvitee(user_id=ISHAY)])

    assert _invited_keys(hub, proj) == [ISHAY]
    assert [(r.user_id, r.reason) for r in proj.last_share_result.skipped] == [(SHARER, "self")]


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_one_failure_does_not_stop_the_rest(hub):
    proj = _project(hub, "share-mixed-outcomes")
    hub.answers[DANA] = 500

    await proj.share(invitees=[ShareInvitee(user_id=DANA), ShareInvitee(user_id=ISHAY)], teams=[f"team-{ZSCHOOL}"])

    result = proj.last_share_result
    assert [r.user_id for r in result.invited] == [ISHAY]
    assert [(r.user_id, r.status) for r in result.failed] == [(DANA, 500)]
    assert [t.team for t in result.granted_teams] == [f"team-{ZSCHOOL}"]


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_share_without_note_sends_no_message_field(hub):
    proj = _project(hub, "share-no-note")

    await proj.share(invitees=[ShareInvitee(user_id=ISHAY)])

    (body,) = _person_invites(hub, proj)
    assert "message" not in body and "notify_by_message" not in body
    (header,) = _message_headers(hub)
    assert header["text"] == 'I invited you to project "share-no-note".'


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_share_with_no_invitees_is_publish_only(hub):
    proj = _project(hub, "share-publish-only")

    assert await proj.share() is proj

    assert [(m, p) for m, p, _ in hub] == [("POST", "/graph/project")]
    assert proj.last_share_result is None


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_share_action_carries_teams_and_note_and_returns_the_result(hub, monkeypatch):
    """``POST project/<id>/share`` with ``teams`` + ``note`` reaches ``Project.share``
    and answers with the per-recipient result beside the entity."""
    from flow_sdk.app.actions import share_action

    proj = _project(hub, "share-action-wiring")

    async def fake_get_one(cls, query):
        return proj

    async def fake_save(self, *args, **kwargs):
        return self

    async def fake_publishable(entity, someone):
        return None

    class _Req:
        target_entity_typeid = SimpleNamespace(type="project", id=proj.id)
        someone_typeid = "user-local"

        async def get_post_data(self):
            return {"recipients": [ISHAY], "teams": [f"team-{ZSCHOOL}"], "note": "Hi"}

    monkeypatch.setattr(share_action, "_local_mode_share_blocked", lambda: False)
    monkeypatch.setattr(share_action, "get_current_request_info", lambda: _Req())
    monkeypatch.setattr(Project, "get_one", classmethod(fake_get_one))
    monkeypatch.setattr(Project, "save", fake_save)
    monkeypatch.setattr(
        "flow_sdk.app.actions.project_publish.assert_project_publishable", fake_publishable
    )
    monkeypatch.setattr(
        "flow_sdk.app.actions.flow_message_action._learn_address_book", lambda entries: _noop()
    )

    resp = await share_action.share_entity()

    dumped = resp.model_dump()
    assert dumped["status"] == "SUCCESS", dumped
    assert _invited_keys(hub, proj) == [ISHAY]
    assert [b["principal"] for b in _group_grants(hub, proj)] == [f"team-{ZSCHOOL}"]
    data = dumped["data"]
    assert data["id"] == proj.id
    assert [r["user_id"] for r in data["share_result"]["invited"]] == [ISHAY]
    assert [t["team"] for t in data["share_result"]["granted_teams"]] == [f"team-{ZSCHOOL}"]


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_share_action_on_a_published_project_invites_without_publishing(hub, monkeypatch):
    """Inviting into a project that already has its hub row is a membership grant:
    the share action runs no publish gate (a dirty tree still invites), does not
    re-push the row, and does not re-save publication state."""
    from flow_sdk.app.actions import share_action

    proj = _project(hub, "share-action-invite-only")
    proj.remote = True
    saved: list[Project] = []

    async def fake_get_one(cls, query):
        return proj

    async def fake_save(self, *args, **kwargs):
        saved.append(self)
        return self

    async def refuse_publish(entity, someone):
        raise AssertionError("an invite must not run the publish gate")

    class _Req:
        target_entity_typeid = SimpleNamespace(type="project", id=proj.id)
        someone_typeid = "user-local"

        async def get_post_data(self):
            return {"recipients": [ISHAY], "note": "Hi"}

    monkeypatch.setattr(share_action, "_local_mode_share_blocked", lambda: False)
    monkeypatch.setattr(share_action, "get_current_request_info", lambda: _Req())
    monkeypatch.setattr(Project, "get_one", classmethod(fake_get_one))
    monkeypatch.setattr(Project, "save", fake_save)
    monkeypatch.setattr("flow_sdk.app.actions.project_publish.assert_project_publishable", refuse_publish)
    monkeypatch.setattr(
        "flow_sdk.app.actions.flow_message_action._learn_address_book", lambda entries: _noop()
    )

    resp = await share_action.share_entity()

    dumped = resp.model_dump()
    assert dumped["status"] == "SUCCESS", dumped
    assert ("POST", "/graph/project") not in [(m, p) for m, p, _ in hub]
    assert _invited_keys(hub, proj) == [ISHAY]
    assert saved == []
    assert [r["user_id"] for r in dumped["data"]["share_result"]["invited"]] == [ISHAY]


async def _noop():
    return None
