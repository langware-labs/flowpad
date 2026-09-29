"""``ShareResultSpec`` — per-person and per-team outcome of a project share.

A team is granted on the hub as ONE group principal, so its outcome is its own
list: ``granted_teams`` (with the team conversation, or ``None`` when the grant
landed but the message did not), ``skipped_teams`` (``already_granted`` only) and
``failed_teams`` (the hub refused the grant).

# do not increase timeout without approval
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from flow_sdk.schema.data_spec.share_result_spec import (
    ShareFailedTeamSpec,
    ShareGrantedTeamSpec,
    ShareResultSpec,
    ShareSkippedTeamSpec,
)

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval

_TEAM_A = "team-2810054c-5f23-4821-a683-39a3dc38177e"
_TEAM_B = "team-5b1dcd12-6eb6-4395-90f3-6aba7d56335d"
_TEAM_C = "team-9df6a461-a001-46cf-9f05-baf05038a49d"


def test_team_outcomes_round_trip() -> None:
    result = ShareResultSpec(
        granted_teams=[ShareGrantedTeamSpec(team=_TEAM_A, name="sandbox-team", conversation_id="c-1")],
        skipped_teams=[ShareSkippedTeamSpec(team=_TEAM_B, name="done", reason="already_granted")],
        failed_teams=[ShareFailedTeamSpec(team=_TEAM_C, name="locked", status=403, message="Forbidden")],
    )

    again = ShareResultSpec.model_validate(result.model_dump())

    assert again == result
    assert again.granted_teams[0].conversation_id == "c-1"
    assert again.skipped_teams[0].reason == "already_granted"
    assert (again.failed_teams[0].status, again.failed_teams[0].message) == (403, "Forbidden")


def test_a_granted_team_may_have_no_conversation() -> None:
    granted = ShareGrantedTeamSpec(team=_TEAM_A)
    assert granted.conversation_id is None


def test_unknown_key_is_rejected() -> None:
    with pytest.raises(ValidationError):
        ShareGrantedTeamSpec.model_validate({"team": _TEAM_A, "members": 3})


def test_skipped_team_reason_is_only_already_granted() -> None:
    with pytest.raises(ValidationError):
        ShareSkippedTeamSpec(team=_TEAM_A, reason="not_listable")


def test_empty_result_has_every_list() -> None:
    dumped = ShareResultSpec().model_dump()
    assert dumped == {
        "invited": [],
        "skipped": [],
        "failed": [],
        "granted_teams": [],
        "skipped_teams": [],
        "failed_teams": [],
    }
