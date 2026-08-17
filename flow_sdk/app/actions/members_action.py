"""Generic ``members`` action — read/mutate the role roster of any entity.

Membership is a fully hub-authoritative capability: a user always has a hub-set
role on a remote entity (a ``RoleRelationship`` edge), and the local store is a
thin READ cache (``Entity.members``). Reflection is requested per call: the TS SDK
sets ``ActionInfo.hub_reflect``, sending ``Hub-Reflect: true``. When the entity
has a hub counterpart (``remote=True``) and the user is logged in, the dispatcher
in ``graph.py`` forwards the call to the hub and mirrors the response onto the
local row (see ``_hub_reflect``).

Read (GET) falls back to the local cache when reflection didn't happen (not
requested, local-only entity, or hub unreachable) — a stale roster read is fine.
MUTATIONS (POST/PUT/DELETE) are hub-only: there is no local membership store, so
when the local body runs it means the mutation could NOT reach the hub, and it
must FAIL LOUDLY (409) rather than fake-success. The UI also disables these
controls when membership is unavailable; the 409 is the backstop.
"""
from __future__ import annotations

from fastapi import HTTPException

from flow_sdk.actions import action
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiResponse, ApiSuccessResponse

# Raised by every mutation when the local body runs (i.e. the call was not
# reflected to the hub). 409 Conflict: the request can't be honored in the
# current state (no hub connection).
_OFFLINE_DETAIL = "Membership changes require Flowpad Cloud; you're offline or signed out."


def _members(entity: Entity) -> list:
    """The entity's cached role roster, or an empty list when it has none."""
    return list(getattr(entity, "members", []) or [])


def _members_local(self: Entity) -> ApiSuccessResponse:
    """The local body for every ``members`` verb.

    The action dispatcher resolves the ``members`` handler by NAME, not by HTTP
    method (``action.get_by_name``), so all four registered handlers funnel here
    and branch on the ACTUAL request method:

    - GET  → return the cached roster. Reads are stale-tolerant; when the call
      isn't reflected (local-only entity / offline / signed out) the cache is
      the best available answer.
    - POST/PUT/DELETE → 409. Membership is hub-owned and there is no local
      membership store, so a mutation reaching this local body means it could
      NOT reach the hub — fail loudly instead of the old fake-success.
    """
    info = get_current_request_info()
    method = (getattr(info, "method", None) or "GET").upper()
    if method == "GET":
        return ApiResponse.success(data=_members(self))
    raise HTTPException(status_code=409, detail=_OFFLINE_DETAIL)


@action.get(action_name="members", types="all")
async def list_members(self: Entity) -> ApiSuccessResponse:
    return _members_local(self)


@action.post(action_name="members", types="all")
async def invite_member(self: Entity) -> ApiSuccessResponse:
    """Invite a member — hub ``create_membership``; POST body is a ``MembershipRequest``."""
    return _members_local(self)


@action.all(action_name="members", methods="put", types="all")
async def set_member_role(self: Entity) -> ApiSuccessResponse:
    """Change a member's role — hub ``update_membership``; PUT body is ``{user_id, role}``."""
    return _members_local(self)


@action.delete(action_name="members", types="all")
async def remove_member(self: Entity) -> ApiSuccessResponse:
    """Remove a member — hub ``delete_membership``; DELETE body is a ``MembershipMethod``."""
    return _members_local(self)
