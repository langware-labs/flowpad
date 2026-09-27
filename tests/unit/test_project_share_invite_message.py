"""``Project.share`` sends one flagged person invite per new invitee — teams included.

The project share invites each person with ``notify_by_message`` so the hub opens
a conversation with the sharer (KTD1). A picked team is expanded by the SHARER's
client through the team's own member list (KTD5): approved user rows become
invitees by ``user_id``, nested teams are walked with a visited set, pending rows
are left out, and a team whose list refuses the sharer is skipped and reported —
never guessed at (KTD6, R17). People and team members merge into one set keyed by
``user_id`` then email, the sharer and anyone already on the project are dropped
(KTD8, R4), and each person's outcome is collected rather than one failure
stopping the rest (KTD7).

Only the single network hop (``FlowpadClient.request``) is stubbed, same as
``test_project_share_invite_by_user_id.py``.
"""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from flow_sdk.schema.data_spec.share_request_spec import ShareInvitee
from flow_sdk.builtin.project import Project

SHARER = "0a0a0a0a-0000-4000-8000-000000000001"
ISHAY = "1b1b1b1b-0000-4000-8000-000000000002"
DANA = "2c2c2c2c-0000-4000-8000-000000000003"
ELI = "3d3d3d3d-0000-4000-8000-000000000004"
MIA = "4e4e4e4e-0000-4000-8000-000000000005"
PENDING = "5f5f5f5f-0000-4000-8000-000000000006"
ZSCHOOL = "6a6a6a6a-0000-4000-8000-000000000007"
ZKIDS = "7b7b7b7b-0000-4000-8000-000000000008"
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
    ``answers`` maps a recipient key (user id or email) to the POST reply — a
    ``dict`` of response data, or an int status for a failure.
    """

    rosters: dict
    answers: dict


@pytest.fixture()
def hub(monkeypatch):
    calls = _Hub()
    calls.rosters = {}
    calls.answers = {}

    async def fake_request(self, method, path, **kwargs):
        body = kwargs.get("json")
        calls.append((method, path, body))
        if method == "GET":
            rows = calls.rosters.get(path, [])
            if isinstance(rows, int):
                return _FakeResponse(rows, {"detail": "Forbidden"})
            return _ok(rows)
        if path.endswith("/members"):
            key = body.get("recipient_user_id") or body.get("recipient_email")
            answer = calls.answers.get(key, {"conversation_id": f"conv-{key}"})
            if isinstance(answer, int):
                return _FakeResponse(answer, {"detail": "boom"})
            return _ok(answer)
        return _ok({})  # the publish POST

    monkeypatch.setattr(
        "flow_sdk.cli.auth.credentials.load_credentials",
        lambda: SimpleNamespace(api_key="test-key", user={"id": SHARER, "email": "sharer@example.com"}),
    )
    monkeypatch.setattr("flow_sdk.cloud_client.client.ApiConfig.from_env", staticmethod(lambda: None))
    monkeypatch.setattr("flow_sdk.cloud_client.client.FlowpadClient.request", fake_request)
    return calls


def _team_path(team_id: str) -> str:
    return f"/graph/team/{team_id}/members"


def _invites(hub: _Hub, proj: Project) -> list[dict]:
    return [body for method, path, body in hub if method == "POST" and path == f"/graph/project/{proj.id}/members"]


def _invited_keys(hub: _Hub, proj: Project) -> list[str]:
    return sorted(b.get("recipient_user_id") or b.get("recipient_email") for b in _invites(hub, proj))


def _project(hub: _Hub, name: str, roster: list[dict] | None = None) -> Project:
    proj = Project(name=name)
    hub.rosters[f"/graph/project/{proj.id}/members"] = roster if roster is not None else [
        _user(SHARER, email="sharer@example.com", name="Sharer") | {"role": "owner"}
    ]
    return proj


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_person_and_team_each_get_one_flagged_invite_with_the_note(hub):
    """Share with Ishay and team zschool (Dana, Eli) → three person calls, each
    flagged, each carrying the note, team members addressed by ``user_id``."""
    proj = _project(hub, "share-person-and-team")
    hub.rosters[_team_path(ZSCHOOL)] = [_user(DANA, email="dana@example.com"), _user(ELI)]

    await proj.share(invitees=[ShareInvitee(user_id=ISHAY)], teams=[f"team-{ZSCHOOL}"], note="Welcome aboard")

    invites = _invites(hub, proj)
    assert _invited_keys(hub, proj) == sorted([ISHAY, DANA, ELI])
    assert all(b["notify_by_message"] is True for b in invites)
    assert all(b["message"] == "Welcome aboard" for b in invites)
    # A team member is sent by hub id even when the admin's roster shows an email.
    assert all("recipient_email" not in b for b in invites)
    assert all(b["invitation_targets"] == [{"typeid": f"project-{proj.id}", "role": "member"}] for b in invites)
    result = proj.last_share_result
    assert sorted(r.user_id for r in result.invited) == sorted([ISHAY, DANA, ELI])
    assert {r.conversation_id for r in result.invited} == {f"conv-{k}" for k in (ISHAY, DANA, ELI)}
    assert result.skipped == [] and result.failed == [] and result.skipped_teams == []


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_ae1_only_the_new_team_member_is_invited_and_the_sharer_never(hub):
    """AE1: zschool holds the sharer, Dana (already on P) and Eli → only Eli."""
    proj = _project(
        hub,
        "share-ae1",
        roster=[_user(SHARER, name="Sharer") | {"role": "owner"}, _user(DANA)],
    )
    hub.rosters[_team_path(ZSCHOOL)] = [_user(SHARER), _user(DANA), _user(ELI)]

    await proj.share(teams=[f"team-{ZSCHOOL}"])

    assert _invited_keys(hub, proj) == [ELI]
    skipped = {r.user_id: r.reason for r in proj.last_share_result.skipped}
    assert skipped == {SHARER: "self", DANA: "already_member"}


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_sharer_is_dropped_even_when_the_project_roster_is_unreadable(hub):
    """The roster read degrades to "invite everyone" — but never the sharer."""
    proj = _project(hub, "share-sharer-no-roster")
    hub.rosters[f"/graph/project/{proj.id}/members"] = 503
    hub.rosters[_team_path(ZSCHOOL)] = [_user(SHARER), _user(ELI)]

    await proj.share(teams=[f"team-{ZSCHOOL}"])

    assert _invited_keys(hub, proj) == [ELI]


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_ae2_a_person_picked_by_name_and_through_a_team_gets_one_invite(hub):
    """AE2: Eli picked by name and in zschool → one call for Eli."""
    proj = _project(hub, "share-ae2")
    hub.rosters[_team_path(ZSCHOOL)] = [_user(ELI, email="eli@example.com")]

    await proj.share(invitees=[ShareInvitee(email="Eli@Example.com")], teams=[f"team-{ZSCHOOL}"])

    invites = _invites(hub, proj)
    assert len(invites) == 1
    # The merge keeps the stable key: the team row taught us Eli's id.
    assert invites[0].get("recipient_user_id") == ELI


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_ae3_everyone_already_on_the_project_means_no_person_calls(hub):
    """AE3: everyone picked already holds a role (or a pending invitation) on P."""
    proj = _project(
        hub,
        "share-ae3",
        roster=[
            _user(SHARER) | {"role": "owner"},
            _user(DANA),
            {"type": "user", "user_id": None, "user_email": "noa@example.com", "status": "pending"},
        ],
    )
    hub.rosters[_team_path(ZSCHOOL)] = [_user(DANA)]

    await proj.share(invitees=[ShareInvitee(email="noa@example.com")], teams=[f"team-{ZSCHOOL}"])

    assert _invites(hub, proj) == []
    result = proj.last_share_result
    assert result.invited == [] and result.failed == []
    assert sorted(r.reason for r in result.skipped) == ["already_invited", "already_member"]


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_nested_team_members_are_invited_and_a_cycle_terminates(hub):
    """zschool contains zkids (Mia approved), and zkids names zschool back."""
    proj = _project(hub, "share-nested")
    hub.rosters[_team_path(ZSCHOOL)] = [_user(ELI), _team(ZKIDS, "zkids")]
    hub.rosters[_team_path(ZKIDS)] = [_user(MIA), _team(ZSCHOOL, "zschool")]

    await proj.share(teams=[f"team-{ZSCHOOL}"])

    assert _invited_keys(hub, proj) == sorted([ELI, MIA])
    team_reads = [p for m, p, _ in hub if m == "GET" and p.startswith("/graph/team/")]
    assert sorted(team_reads) == sorted([_team_path(ZSCHOOL), _team_path(ZKIDS)]), "each team read once"


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_a_pending_team_row_is_not_a_team_member(hub):
    proj = _project(hub, "share-pending-row")
    hub.rosters[_team_path(ZSCHOOL)] = [
        _user(ELI),
        _user(PENDING, status="pending"),
        {"type": "user", "user_id": None, "user_email": "invited@example.com", "status": "pending"},
    ]

    await proj.share(teams=[f"team-{ZSCHOOL}"])

    assert _invited_keys(hub, proj) == [ELI]


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_ae9_a_team_the_sharer_may_not_list_is_skipped_and_reported(hub):
    """AE9: zschool's member list refuses the sharer (403) → nothing is sent for
    zschool, it is reported as not listable, and picked people still go out."""
    proj = _project(hub, "share-ae9")
    hub.rosters[_team_path(ZSCHOOL)] = 403

    await proj.share(invitees=[ShareInvitee(user_id=ISHAY)], teams=[f"team-{ZSCHOOL}"])

    assert _invited_keys(hub, proj) == [ISHAY]
    result = proj.last_share_result
    assert [(t.team, t.reason) for t in result.skipped_teams] == [(f"team-{ZSCHOOL}", "not_listable")]


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_a_refused_nested_team_is_skipped_while_its_parent_is_expanded(hub):
    proj = _project(hub, "share-refused-nested")
    hub.rosters[_team_path(ZSCHOOL)] = [_user(ELI), _team(LOCKED, "locked")]
    hub.rosters[_team_path(LOCKED)] = 403

    await proj.share(teams=[f"team-{ZSCHOOL}"])

    assert _invited_keys(hub, proj) == [ELI]
    assert [(t.team, t.name, t.reason) for t in proj.last_share_result.skipped_teams] == [
        (f"team-{LOCKED}", "locked", "not_listable")
    ]


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_hub_skip_and_failure_are_reported_per_person_and_do_not_stop_the_rest(hub):
    """One person answered with a skip reason → skipped; one answered 500 →
    failed; everyone else is still sent."""
    proj = _project(hub, "share-per-person-outcomes")
    hub.answers[DANA] = {"skipped": True, "skip_reason": "already_has_access"}
    hub.answers[ELI] = 500

    await proj.share(invitees=[ShareInvitee(user_id=u) for u in (DANA, ELI, MIA)])

    assert _invited_keys(hub, proj) == sorted([DANA, ELI, MIA])
    result = proj.last_share_result
    assert [r.user_id for r in result.invited] == [MIA]
    assert [(r.user_id, r.reason) for r in result.skipped] == [(DANA, "already_has_access")]
    assert [(r.user_id, r.status) for r in result.failed] == [(ELI, 500)]
    assert result.failed[0].message


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_share_without_note_sends_no_message_field(hub):
    proj = _project(hub, "share-no-note")

    await proj.share(invitees=[ShareInvitee(user_id=ISHAY)])

    (body,) = _invites(hub, proj)
    assert body["notify_by_message"] is True
    assert "message" not in body


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
    and answers with the per-person result beside the entity."""
    from flow_sdk.app.actions import share_action

    proj = _project(hub, "share-action-wiring")
    hub.rosters[_team_path(ZSCHOOL)] = [_user(ELI)]

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
    assert _invited_keys(hub, proj) == sorted([ISHAY, ELI])
    assert all(b["message"] == "Hi" for b in _invites(hub, proj))
    data = dumped["data"]
    assert data["id"] == proj.id
    assert sorted(r["user_id"] for r in data["share_result"]["invited"]) == sorted([ISHAY, ELI])



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
