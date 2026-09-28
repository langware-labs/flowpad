"""``ShareResultSpec`` — what a share with people and teams did, per recipient.

A share sends one person invite per new invitee and one hub GROUP grant per new
team, so there is no single success. Each person is ``invited`` (with the invite
conversation the sharing client opened), ``skipped`` (with why — the sharer
themself, already on the entity, or already invited), or ``failed`` (with the
hub's status and message). Each team is ``granted_teams`` (with its team
conversation, or ``None`` when the grant landed but the message could not be
sent), ``skipped_teams`` (it already holds a role on the entity), or
``failed_teams`` (the grant itself was refused).

The same field names are the TS SDK's ``ProjectShareResult``, so a caller on
either side reads one shape.
"""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import ConfigDict, Field

from flow_sdk.schema.data_spec.spec import DataSpec


class ShareRecipientSpec(DataSpec):
    """One person a share addressed: a hub ``user_id``, an email, or both."""

    model_config = ConfigDict(frozen=True)

    user_id: Optional[str] = None
    email: Optional[str] = None
    name: Optional[str] = None


class ShareInvitedSpec(ShareRecipientSpec):
    #: The 1:1 invite conversation the sharing client opened with this person.
    conversation_id: Optional[str] = None


class ShareSkippedSpec(ShareRecipientSpec):
    #: ``self`` | ``already_member`` | ``already_invited`` | the hub's reason.
    reason: str


class ShareFailedSpec(ShareRecipientSpec):
    #: The hub's HTTP status, when there was a response at all.
    status: Optional[int] = None
    message: str


class ShareTeamSpec(DataSpec):
    """One team a share addressed."""

    model_config = ConfigDict(frozen=True)

    #: The team's typeid string (``team-<uuid>``).
    team: str
    name: Optional[str] = None


class ShareGrantedTeamSpec(ShareTeamSpec):
    #: The team invite conversation, granted to the whole team; ``None`` when the
    #: grant landed but opening or posting the conversation failed.
    conversation_id: Optional[str] = None


class ShareSkippedTeamSpec(ShareTeamSpec):
    #: ``already_granted`` — the team already holds a role on the entity, so no
    #: second grant, conversation or message is sent.
    reason: Literal["already_granted"]


class ShareFailedTeamSpec(ShareTeamSpec):
    #: The hub's HTTP status, when there was a response at all.
    status: Optional[int] = None
    message: str


class ShareResultSpec(DataSpec):
    model_config = ConfigDict(frozen=True)

    invited: list[ShareInvitedSpec] = Field(default_factory=list)
    skipped: list[ShareSkippedSpec] = Field(default_factory=list)
    failed: list[ShareFailedSpec] = Field(default_factory=list)
    granted_teams: list[ShareGrantedTeamSpec] = Field(default_factory=list)
    skipped_teams: list[ShareSkippedTeamSpec] = Field(default_factory=list)
    failed_teams: list[ShareFailedTeamSpec] = Field(default_factory=list)
