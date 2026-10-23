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
        # Strict callers use absence as evidence for an invitation suggestion.
        # Reflection GET does not forward local query parameters to the hub.
        require_authoritative = (getattr(info, "request_parameters", None) or {}).get("require_authoritative")
        if require_authoritative is True or str(require_authoritative).lower() in {"true", "1"}:
            raise HTTPException(status_code=409, detail="Project membership could not be confirmed with Flowpad Cloud.")
        return ApiResponse.success(data=_members(self))
    raise HTTPException(status_code=409, detail=_OFFLINE_DETAIL)


@action.all(action_name="members", methods=["get", "post", "put", "delete"], types="all")
async def members(self: Entity) -> ApiSuccessResponse:
    """``<type>/<id>/members``. POST invites (a ``MembershipRequest``, or ``members/link``) and is
    answered here; every other verb reads the local roster cache. Role changes (PUT) and removals
    (DELETE) of a hub row are reflected to the hub before they reach this handler."""
    info = get_current_request_info()
    if (getattr(info, "method", None) or "GET").upper() == "POST":
        return await _invite(self)
    return _members_local(self)


async def _invite(self: Entity) -> ApiSuccessResponse:
    """``POST <type>/<id>/members`` (a ``MembershipRequest``) or ``members/link``, answered here
    rather than reflected (``_hub_reflect._admits_locally``) so the desktop does its part before the
    same request reaches the hub:

    - a conversation admits through ``Conversation.share``, which also grants its shared
      skills/agents in the same invitation;
    - any other row is published first when the hub lacks it, then the request goes on unchanged;
    - an invite link is minted on the hub once the row is there.

    Answers the refreshed roster (the link, for ``/link``). Without the hub it fails loudly (409).
    """
    if not _can_reach_hub():
        raise HTTPException(status_code=409, detail=_OFFLINE_DETAIL)
    from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415
    from flow_sdk.cloud_client.shared.errors import HubError  # noqa: PLC0415

    body = await _post_body()
    sub_path = (getattr(get_current_request_info(), "sub_path", None) or "").strip("/")
    try:
        if sub_path == "link":
            await _ensure_on_hub(self)
            link = await HubProxy.call("POST", self.type, self.id, "members", "link", payload=body, strict=True)
            return ApiResponse.success(data=link)
        await _admit(self, body)
    except HubError as exc:
        return exc.fail_response("Invite failed")
    return ApiResponse.success(data=await _refresh_roster(self))


async def _ensure_on_hub(entity: Entity) -> None:
    if getattr(entity, "remote", False) is not True:
        await entity.share()


async def _admit(self: Entity, body: dict) -> None:
    """Send one ``MembershipRequest`` to the hub, after the desktop's own step for this entity."""
    if getattr(self, "type", None) == "conversation":
        email, user_id, principal = (_identity(body, k) for k in _IDENTITY_KEYS)
        if not (email or user_id or principal):
            raise HTTPException(status_code=400, detail="members: recipient_email, recipient_user_id or principal")
        try:
            await self.share(
                recipients=[email] if email else None,
                recipient_user_ids=[user_id] if user_id else None,
                principals=[principal] if principal else None,
                notify_by_email=body.get("notify_by_email") is not False,
                invitation={k: v for k, v in body.items() if k not in (*_IDENTITY_KEYS, "notify_by_email")},
            )
        except RuntimeError as e:  # ``share`` refuses before sending when this box holds no login
            from flow_sdk.cloud_client.shared.errors import HubError  # noqa: PLC0415
            from flow_sdk.schema.data_spec.hub_failure_spec import HubFailureKind  # noqa: PLC0415

            raise HubError(0, str(e), kind=HubFailureKind.SIGNED_OUT) from e
    else:
        from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415

        await _ensure_on_hub(self)
        await HubProxy.call("POST", self.type, self.id, "members", payload=body, strict=True)


_IDENTITY_KEYS = ("recipient_email", "recipient_user_id", "principal")


def _identity(body: dict, key: str) -> str | None:
    """One addressing field of a ``MembershipRequest``; anything but a string is a 400, not a 500."""
    value = body.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise HTTPException(status_code=400, detail=f"members: {key} must be a string")
    return value.strip() or None


def _can_reach_hub() -> bool:
    from flow_sdk.server.routes._hub_reflect import is_local_mode, is_logged_in  # noqa: PLC0415

    return is_logged_in() and not is_local_mode()


async def _post_body() -> dict:
    info = get_current_request_info()
    body = await info.get_post_data() if info else None
    return body if isinstance(body, dict) else {}


async def _refresh_roster(entity: Entity) -> list:
    """Re-read the hub roster into the local cache after a change; the cache answers when the hub can't."""
    from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415
    from flow_sdk.server.routes._hub_reflect import (  # noqa: PLC0415
        normalize_hub_response,
        mirror_hub_response_into_local,
    )

    try:
        data = await HubProxy.call("GET", entity.type, entity.id, "members")
    except Exception:  # noqa: BLE001 — the invitation is sent; a stale roster is fine
        return _members(entity)
    await mirror_hub_response_into_local(entity, "members", normalize_hub_response("members", data))
    return _members(entity)
