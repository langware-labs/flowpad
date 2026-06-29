"""Generic ``members`` action — list participants of any entity.

Reflection is requested per call: the TS SDK sets ``ActionInfo.hub_reflect`` on
these calls, which sends the ``Hub-Reflect: true`` header. When the entity also
has a hub counterpart (``remote=True``) and the user is logged in, the dispatcher
in ``graph.py`` forwards the call to the hub and mirrors the response onto the
local row (see ``_hub_reflect.should_reflect_to_hub``).

The local body runs when the call didn't request reflection, the entity is
local-only, or the hub is unreachable — it returns whatever participants the
entity has cached. Entities without a ``participants`` field return an empty list.
"""
from __future__ import annotations

from flow_sdk.actions import action
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.responses.response import ApiResponse, ApiSuccessResponse


def _participants(entity: Entity) -> list:
    """The entity's cached participants, or an empty list when it has none."""
    return list(getattr(entity, "participants", []) or [])


@action.get(action_name="members", types="all")
async def list_members(self: Entity) -> ApiSuccessResponse:
    return ApiResponse.success(data=_participants(self))


@action.post(action_name="members", types="all")
async def invite_member(self: Entity) -> ApiSuccessResponse:
    """Invite a member — reflection enabler. Like ``list_members``, the SDK
    calls this with ``hub_reflect`` set: for a ``remote`` entity (e.g. an
    organization or team) the dispatcher forwards the POST to the hub's
    ``create_membership`` (which creates the Invitation + emails the recipient)
    and mirrors the resulting roster back. The POST body is a
    ``MembershipRequest`` — ``{recipient_email, invitation_targets:[{typeid, role}]}``.

    There is no local-only membership store, so the local body is a no-op
    success — the reflect path is the real implementation. A registered POST
    handler is required for the dispatcher to match (and therefore reflect) the
    call; without it the route 404s before reflection."""
    return ApiResponse.success(data=_participants(self))


@action.all(action_name="members", methods="put", types="all")
async def set_member_role(self: Entity) -> ApiSuccessResponse:
    """Change a member's role — reflection enabler (hub-owned). Forwarded to the
    hub for a ``remote`` entity; the PUT body is ``{user_id, role}``. Local body
    is a no-op success."""
    return ApiResponse.success(data=_participants(self))


@action.delete(action_name="members", types="all")
async def remove_member(self: Entity) -> ApiSuccessResponse:
    """Remove a member — OWNER ONLY (enforced hub-side in
    ``delete_membership``). Like ``list_members``, the SDK calls this with
    ``hub_reflect`` set: for a ``remote`` entity the dispatcher forwards the
    DELETE to the hub (which revokes the role + strips the participant + fans the
    update) and mirrors the resulting roster back onto the local row. The DELETE
    body is a ``MembershipMethod`` — ``{member_through: "id", value: "<user_id>"}``.

    The local body runs only for local-only entities or when the hub is
    unreachable; there is no local-only membership store, so it's a no-op
    success (the reflect path is the real implementation)."""
    return ApiResponse.success(data=_participants(self))
