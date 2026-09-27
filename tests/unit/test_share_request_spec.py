"""``ShareRequestSpec`` — the typed body of ``POST /graph/<type>/<id>/share``.

The TS SDK posts the entity's own JSON alongside ``recipients``, so the body is a
foreign dict: ``from_body`` projects the three share keys field by field and
ignores the rest, while the spec itself stays ``extra="forbid"``.

# do not increase timeout without approval
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from flow_sdk.app.actions.share_action import ShareInvitee, ShareRequestSpec

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval

_USER_ID = "3f2a8c1e-4b5d-4e6f-8a9b-0c1d2e3f4a5b"
_TEAM = "team-2810054c-5f23-4821-a683-39a3dc38177e"


def test_empty_body_is_a_plain_share() -> None:
    spec = ShareRequestSpec.from_body({})
    assert spec.recipients == ()
    assert spec.teams == ()
    assert spec.note is None


def test_recipients_resolve_to_invitees_in_both_wire_shapes() -> None:
    spec = ShareRequestSpec.from_body(
        {"recipients": ["Eli@Example.com", _USER_ID, {"idOrEmail": "dana@example.com", "role": "editor"}]}
    )
    assert spec.recipients == (
        ShareInvitee(email="eli@example.com"),
        ShareInvitee(user_id=_USER_ID),
        ShareInvitee(email="dana@example.com", role="editor"),
    )


def test_teams_are_stripped_team_typeids_and_note_is_kept() -> None:
    spec = ShareRequestSpec.from_body({"teams": [f"  {_TEAM} "], "note": "have a look"})
    assert spec.teams == (_TEAM,)
    assert spec.note == "have a look"


def test_from_body_ignores_the_entity_fields_the_ts_sdk_sends_alongside() -> None:
    spec = ShareRequestSpec.from_body({"id": "x", "type": "project", "name": "P", "recipients": ["a@b.co"]})
    assert spec.recipients == (ShareInvitee(email="a@b.co"),)


def test_the_spec_itself_rejects_unknown_keys() -> None:
    with pytest.raises(ValidationError):
        ShareRequestSpec.model_validate({"recipients": [], "name": "P"})


@pytest.mark.parametrize(
    "body",
    [
        {"recipients": "a@b.co"},
        {"recipients": [""]},
        {"recipients": [{"idOrEmail": "a@b.co", "unexpected": 1}]},
        {"teams": "team-x"},
        {"teams": ["project-2810054c-5f23-4821-a683-39a3dc38177e"]},
        {"teams": ["  "]},
        {"note": 5},
    ],
)
def test_malformed_share_keys_are_rejected(body: dict) -> None:
    with pytest.raises(ValidationError):
        ShareRequestSpec.from_body(body)


def test_spec_is_a_frozen_value() -> None:
    spec = ShareRequestSpec.from_body({"note": "hi"})
    with pytest.raises(ValidationError):
        spec.note = "changed"  # type: ignore[misc]
