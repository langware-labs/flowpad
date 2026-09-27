"""``ShareResultSpec`` — what a share with people and teams did, per person.

A share sends one person invite per new invitee (KTD7 of the project-share invite
plan), so there is no single success: each person is ``invited`` (with the invite
conversation the hub opened, when it opened one), ``skipped`` (with why — the
sharer themself, already on the entity, or the hub's own skip reason), or
``failed`` (with the hub's status and message). A picked team whose member list
the sharer may not read is in ``skipped_teams``; nothing was sent for it.

The same field names are the TS SDK's ``ProjectShareResult``, so a caller on
either side reads one shape.
"""
from __future__ import annotations

from typing import Optional

from pydantic import ConfigDict, Field

from flow_sdk.schema.data_spec.spec import DataSpec


class ShareRecipientSpec(DataSpec):
    """One person a share addressed: a hub ``user_id``, an email, or both."""

    model_config = ConfigDict(frozen=True)

    user_id: Optional[str] = None
    email: Optional[str] = None
    name: Optional[str] = None


class ShareInvitedSpec(ShareRecipientSpec):
    #: The invite conversation the hub opened with the sharer; ``None`` when the
    #: hub did not report one.
    conversation_id: Optional[str] = None


class ShareSkippedSpec(ShareRecipientSpec):
    #: ``self`` | ``already_member`` | ``already_invited`` | the hub's reason.
    reason: str


class ShareFailedSpec(ShareRecipientSpec):
    #: The hub's HTTP status, when there was a response at all.
    status: Optional[int] = None
    message: str


class ShareSkippedTeamSpec(DataSpec):
    model_config = ConfigDict(frozen=True)

    #: The team's typeid string (``team-<uuid>``).
    team: str
    name: Optional[str] = None
    #: ``not_listable`` — the team's member list refused the sharer;
    #: ``no_members`` — it answered with nobody at all (a refusal the local
    #: reflection layer degraded to an empty read looks exactly like this).
    reason: str
    message: Optional[str] = None


class ShareResultSpec(DataSpec):
    model_config = ConfigDict(frozen=True)

    invited: list[ShareInvitedSpec] = Field(default_factory=list)
    skipped: list[ShareSkippedSpec] = Field(default_factory=list)
    failed: list[ShareFailedSpec] = Field(default_factory=list)
    skipped_teams: list[ShareSkippedTeamSpec] = Field(default_factory=list)
