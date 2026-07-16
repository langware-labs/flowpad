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
from flow_sdk.instance_settings.privacy_mode import is_local_mode
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
        and not is_local_mode()
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


async def reflect_to_hub(
    a: Action,
    entity: Entity,
    body: dict[str, Any],
    method: str,
    sub_path: str | None = None,
) -> Any:
    """Forward the action call to the hub and mirror the response into the local row.

    ``method`` is the **actual incoming HTTP method** (e.g. from
    ``RequestInfo.method``). The hub verb is taken from it verbatim — NOT inferred
    from the matched action's static ``a.methods``. That inference was the bug: an
    action name (e.g. ``members``) registers both a GET (list) and a DELETE
    (remove) handler under one registry key, so a roster GET could resolve to the
    DELETE-registered ``Action`` and reflect a destructive hub DELETE with an empty
    body → hub 400 → the "Cloud request rejected" toast. The request method never
    lies; ``a.methods`` does.

    ``sub_path`` is the segment after the action (``members/link`` → ``"link"``),
    forwarded verbatim so one action name can front several hub endpoints. It also
    *disqualifies* the roster-shaped post-processing below: ``members`` returns a
    participant list, but ``members/link`` returns ``{id, url, …}``, and mirroring
    that onto ``participants`` would corrupt the roster.

    Returns the hub's response payload (the unwrapped ``data`` dict/list),
    after normalizing per-action shapes (e.g. ``members`` field rename).
    Raises ``HubError`` on failure — caller decides whether to fall through
    to the local handler.
    """
    et = _entity_type_enum(entity)
    if et is None:
        raise HubError(0, f"entity type {entity.type!r} has no hub representation")

    hub_id = entity.id
    verb = (method or "").lower()
    # Roster-shaped handling applies to the bare ``members`` action only — a
    # sub-path (``members/link``) is a different hub endpoint with its own shape.
    is_roster = a.action_name == "members" and not sub_path
    if verb == "get":
        hub_resp = await hub_get(et, hub_id, action=a.action_name, sub_path=sub_path)
        # hub_get returns None on transport/HTTP failure (does not raise);
        # treat that as "fall through to local" via HubError.
        if hub_resp is None:
            raise HubError(0, "hub_get returned no data")
    elif verb == "delete":
        # DELETE carries its selector in the body (e.g. members remove →
        # MembershipMethod {member_through, value}); hub_delete sends it as
        # the JSON body and raises HubError on non-200 (e.g. 403 owner-only),
        # which propagates to the caller verbatim.
        hub_resp = await hub_delete(et, hub_id, action=a.action_name, sub_path=sub_path, payload=body or {})
    elif verb in ("put", "patch") and is_roster:
        # Role change — PUT ``/<type>/<id>/members`` with ``{user_id|user_email|
        # invitation_id, role}``. Without this branch the generic PUT below would
        # reflect the body as a bare entity update onto ``/<type>/<id>``, silently
        # writing the member selector onto the conversation row instead of hitting
        # the hub's gated ``update_membership``. Raises HubError on non-200 (e.g.
        # 403 from the hub's ``can_assign`` ceiling), propagated to the caller.
        hub_resp = await hub_put(et, hub_id, body or {}, action=a.action_name)
    elif verb in ("put", "patch"):
        # A bare entity field update (the generic ``update`` CRUD action, e.g. a
        # conversation rename) reflects as a hub PUT to ``/<type>/<id>``. Merge the
        # hub's authoritative response (server-set times etc.) onto the local row +
        # broadcast, then return the MERGED LOCAL entity — the same shape a normal
        # (non-reflected) update returns, so the local cache and the client stay
        # consistent (the hub is the source of truth for every differing scalar).
        hub_resp = await hub_put(et, hub_id, body or {})
        updates = _merge_hub_entity_into_local(entity, hub_resp)
        # A reflected PUT REPLACES the local update — so body fields the hub
        # doesn't model (absent from its response, e.g. a task's local-only
        # ``artifacts`` attachments) would be silently dropped. Apply those
        # from the incoming body, with hub-returned fields staying
        # authoritative (they overwrite on key collision below).
        updates = {**_hub_unknown_updates_from_body(entity, body, hub_resp), **updates}
        if updates:
            entity.apply_field_updates(updates)
            await entity.save(notify=True)  # local row + data_op broadcast to watchers
        return entity.model_dump()
    else:
        hub_resp = await hub_post(et, body or {}, hub_id, action=a.action_name, sub_path=sub_path)

    # A sub-path'd call (e.g. ``members/link`` → {id, url, …}) is not a roster:
    # return the hub's payload verbatim, with no re-fetch, rename, or mirror.
    if sub_path:
        return hub_resp

    # After a successful members mutation (remove / role change) the hub returns
    # a message, not a roster — so re-fetch the canonical roster to mirror
    # locally (keeps participants in sync without a second client round-trip).
    if verb in ("delete", "put", "patch") and is_roster:
        refreshed = await hub_get(et, hub_id, action=a.action_name)
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


_MISSING = object()


def _merge_hub_entity_into_local(entity: Entity, hub_resp: Any) -> dict[str, Any]:
    """Select the hub-authoritative SCALAR fields to merge onto the local entity.

    A reflected ``update`` returns the hub's view of the entity. We apply each API
    field whose hub value is a scalar (``str`` / ``int`` / ``float`` / ``bool`` /
    ``None``) and differs from the local value — which carries the renamed field plus
    server-set timestamps, and deliberately SKIPS list/dict fields. ``participants``
    (a list) is the important skip: its local shape is the normalized ``{email,name}``
    from the members reflect and must not be clobbered by the hub's ``{user_id,…}``
    shape (it has its own sync path). Projection-guarded fields are dropped downstream
    by the entity's ``apply_field_updates`` (e.g. Conversation strips
    ``message_count`` / ``message_ids``). Local-only fields (``project_id``,
    ``dismissed_at``, ``archived_at``) are absent from the hub response → preserved.

    Returns the dict of fields to apply, empty when nothing changed (so the caller
    skips the save+broadcast entirely).
    """
    if not isinstance(hub_resp, dict):
        return {}
    updates: dict[str, Any] = {}
    for k, v in hub_resp.items():
        if not entity.is_api_field(k):
            continue
        if v is not None and not isinstance(v, (str, int, float, bool)):
            continue  # skip list/dict (participants, nested objects, projections-as-list)
        if getattr(entity, k, _MISSING) != v:
            updates[k] = v
    return updates


def _hub_unknown_updates_from_body(entity: Entity, body: dict[str, Any] | None, hub_resp: Any) -> dict[str, Any]:
    """The incoming update's LOCAL-ONLY field changes — API fields the hub's
    response doesn't carry (the hub doesn't model them), which a plain local
    update would have applied. Restores those semantics for reflected PUTs so
    a remote entity can still persist its hub-unknown fields locally.
    """
    if not isinstance(body, dict):
        return {}
    hub_keys = set(hub_resp.keys()) if isinstance(hub_resp, dict) else set()
    updates: dict[str, Any] = {}
    for k, v in body.items():
        if k in ("id", "type") or k in hub_keys:
            continue
        if not entity.is_api_field(k):
            continue
        if getattr(entity, k, _MISSING) != v:
            updates[k] = v
    return updates


async def mirror_hub_response_into_local(entity: Entity, action_name: str, hub_resp: Any) -> None:
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
