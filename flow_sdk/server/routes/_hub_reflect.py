"""Generic action-to-hub reflection.

When a local action runs against an entity that has a hub counterpart
(``entity.remote=True``) and the call opts into reflection (the ``Hub-Reflect``
header, or the ``hub_reflect`` field on a WS ``rest_api_msg`` → ``request_info.hub_reflect``),
the dispatcher forwards the call to the hub instead of invoking the local handler.
The hub's response is then mirrored into the local row so the local cache stays
consistent.

The TS SDK only ever talks to the local server; this module is the seam
that turns the local server into a transparent proxy for remote entities.
"""

from __future__ import annotations

import logging
from typing import Any

from flow_sdk.actions.action_registry import Action
from flow_sdk.cli.auth.hub_login import is_logged_in
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.utils.hub import HubError, hub_delete, hub_get, hub_post, hub_put

logger = logging.getLogger(__name__)


def should_reflect_to_hub(entity: Entity | None, hub_reflect: bool) -> bool:
    """True iff this action call should be forwarded to the hub instead of run locally.

    Reflection is **opt-in per call** via ``hub_reflect`` (the ``Hub-Reflect`` header,
    or the ``hub_reflect`` field on a WS ``rest_api_msg``), default False. The action
    no longer carries a ``reflect`` marker — the request decides. The remaining gates
    are unchanged: the entity must have a hub counterpart and the user must be logged
    in. (Type eligibility is enforced downstream by ``reflect_to_hub`` →
    ``_entity_type_enum`` → ``HubError`` → quiet local fallback.)
    """
    return (
        bool(hub_reflect)
        and entity is not None
        and getattr(entity, "remote", False) is True
        and is_logged_in()
    )


def _entity_type_enum(entity: Entity) -> BuiltinEntityType | None:
    """Map ``entity.type`` (string) to the ``BuiltinEntityType`` enum.

    Returns None when the type isn't a builtin (e.g. plugin-defined entities)
    — those have no hub representation so reflection is a no-op.
    """
    try:
        return BuiltinEntityType(entity.type)
    except ValueError:
        return None


async def reflect_to_hub(a: Action, entity: Entity, body: dict[str, Any], method: str) -> Any:
    """Forward the action call to the hub and mirror the response into the local row.

    ``method`` is the **actual incoming HTTP method** (e.g. from
    ``RequestInfo.method``). The hub verb is taken from it verbatim — NOT inferred
    from the matched action's static ``a.methods``. That inference was the bug: an
    action name (e.g. ``members``) registers both a GET (list) and a DELETE
    (remove) handler under one registry key, so a roster GET could resolve to the
    DELETE-registered ``Action`` and reflect a destructive hub DELETE with an empty
    body → hub 400 → the "Cloud request rejected" toast. The request method never
    lies; ``a.methods`` does.

    Returns the hub's response payload (the unwrapped ``data`` dict/list),
    after normalizing per-action shapes (e.g. ``members`` field rename).
    Raises ``HubError`` on failure — caller decides whether to fall through
    to the local handler.
    """
    et = _entity_type_enum(entity)
    if et is None:
        raise HubError(0, f"entity type {entity.type!r} has no hub representation")

    verb = (method or "").lower()
    if verb == "get":
        hub_resp = await hub_get(et, entity.id, action=a.action_name)
        # hub_get returns None on transport/HTTP failure (does not raise);
        # treat that as "fall through to local" via HubError.
        if hub_resp is None:
            raise HubError(0, "hub_get returned no data")
    elif verb == "delete":
        # DELETE carries its selector in the body (e.g. members remove →
        # MembershipMethod {member_through, value}); hub_delete sends it as
        # the JSON body and raises HubError on non-200 (e.g. 403 owner-only),
        # which propagates to the caller verbatim.
        hub_resp = await hub_delete(et, entity.id, action=a.action_name, payload=body or {})
    elif verb in ("put", "patch"):
        # A bare entity field update (the generic ``update`` CRUD action, e.g. a
        # conversation rename) reflects as a hub PUT to ``/<type>/<id>`` — NOT a
        # POST to ``/<type>/<id>/<action>``. The hub merges the body's fields and
        # fans the update to participants.
        hub_resp = await hub_put(et, entity.id, body or {})
    else:
        hub_resp = await hub_post(et, body or {}, entity.id, action=a.action_name)

    # After a successful remove the hub returns a message, not a roster — so
    # re-fetch the canonical roster to mirror locally (keeps participants in
    # sync without a second client round-trip).
    if verb == "delete" and a.action_name == "members":
        refreshed = await hub_get(et, entity.id, action=a.action_name)
        if refreshed is not None:
            hub_resp = refreshed

    normalized = _normalize_hub_response(a.action_name, hub_resp)
    await mirror_hub_response_into_local(entity, a.action_name, normalized)
    return normalized


def _normalize_hub_response(action_name: str, hub_resp: Any) -> Any:
    """Translate hub field names into the canonical client shape.

    The hub's ``Membership`` response uses ``user_email`` / ``user_name`` /
    ``user_picture``; the client and ``Conversation.participants`` cache
    expect ``email`` / ``name`` / ``picture``. Normalizing here means
    callers (TS SDK, local mirror, downstream UI) all see one shape.

    Unknown keys (``invitation_id``, ``invitation_method``, anything the
    hub adds later) pass through unchanged so future consumers don't need
    a coordinated dispatcher update.
    """
    if action_name != "members" or not isinstance(hub_resp, list):
        return hub_resp

    _HUB_TO_CLIENT = {
        "user_email": "email",
        "user_name": "name",
        "user_picture": "picture",
    }

    out: list[dict] = []
    for entry in hub_resp:
        if not isinstance(entry, dict):
            out.append(entry)
            continue
        # Pass through every non-renamed key verbatim (preserves invitation_id,
        # invitation_method, status, role, and any hub-added field).
        normalized: dict = {k: v for k, v in entry.items() if k not in _HUB_TO_CLIENT}
        # Then fill the client-form names from the legacy hub keys, but don't
        # overwrite a client-form key the entry already had (e.g. if a future
        # hub starts emitting both forms during a migration, the client form
        # wins).
        for hub_key, client_key in _HUB_TO_CLIENT.items():
            if hub_key in entry and client_key not in normalized:
                normalized[client_key] = entry[hub_key]
        out.append(normalized)
    return out


async def mirror_hub_response_into_local(
    entity: Entity, action_name: str, hub_resp: Any
) -> None:
    """Write hub-provided state back into the local entity row.

    Opportunistic: only writes fields the entity already exposes. Generic
    across entity types — no per-type custom logic. Specific actions can
    extend this later if they need richer merge semantics.
    """
    if hub_resp is None:
        return

    # Generic shape: action returns a list whose entries look like
    # participants → mirror onto ``entity.participants`` if the field exists.
    if action_name == "members" and isinstance(hub_resp, list):
        if hasattr(entity, "participants"):
            try:
                new_participants = list(hub_resp)
                # EQUALITY GUARD — only assign+save when the roster actually
                # changed. ``Entity.__setattr__`` marks the row dirty on *any*
                # assignment (it tracks assignment, not value), and ``save()``
                # fans an entity UPDATE. A reflect that re-mirrors the SAME
                # roster would therefore dirty → save → UPDATE → re-arm the
                # next members fetch → reflect again: an unbounded
                # fetch↔mirror↔refetch loop hammering the hub ~14×/s. Comparing
                # against the currently-stored value makes the mirror idempotent:
                # an unchanged roster is a no-op (no assignment, no save, no
                # UPDATE), so the loop converges after the first mirror. Compare
                # the already-normalized stored value against the new normalized
                # value (both went through ``_normalize_hub_response``), so the
                # check isn't defeated by raw-vs-normalized key differences.
                current = list(getattr(entity, "participants", None) or [])
                if current == new_participants:
                    return
                entity.participants = new_participants
                # Best-effort save; never blow up the action if persistence fails.
                save = getattr(entity, "save", None)
                if callable(save):
                    await save()
            except Exception as e:  # noqa: BLE001
                logger.debug("[hub-reflect] mirror save failed for %s: %s", entity.type, e)
