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


def should_reflect_to_hub(entity: Entity | None, hub_reflect: bool, action_name: str | None = None) -> bool:
    """True iff this action call should be forwarded to the hub instead of run locally.

    Reflection is **opt-in per call** via ``hub_reflect`` (the ``Hub-Reflect`` header,
    or the ``hub_reflect`` field on a WS ``rest_api_msg``), default False. The action
    no longer carries a ``reflect`` marker — the request decides. The remaining gates
    are unchanged: the entity must have a hub counterpart and the user must be logged
    in. (Type eligibility is enforced downstream by ``reflect_to_hub`` →
    ``_entity_type_enum`` → ``HubError`` → quiet local fallback.)

    ``fs`` is the one action that reflects on ``remote`` ALONE, without the opt-in.
    Entity FILES must be on the hub by the time any other member asks for them —
    the writer may be offline by then, and unlike a field there is no other copy
    to fall back to. Making it a per-caller courtesy would mean a caller that
    forgets the header (the TS ``fsService`` does not set it, nor do agents or
    the CLI) silently strands the bytes on one machine. Entity FIELD writes stay
    opt-in and already get it automatically — ``FlowSync/store.ts`` sends the
    header whenever ``entity.remote``.
    """
    return (
        (bool(hub_reflect) or action_name == "fs")
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


# Sentinel: the hub side is done, but the LOCAL handler must STILL run. Every
# other action reflects as a *replacement* (the hub's response is the answer);
# entity files are the write-through case — the bytes go to the hub AND stay in
# local storage, which is the cache the headless agent reads by local path.
REFLECT_CONTINUE_LOCAL = object()


async def _reflect_fs_to_hub(et, hub_id: str, sub_path: str | None) -> Any:
    """Mirror an entity-VFS upload to the hub, then let the local write proceed.

    Files on a shared entity are hub-authoritative; this machine's storage is a
    cache. Only ``upload`` needs mirroring — reads are served locally and fill
    from the hub on a miss (``fs_actions.fetch_remote_entity_file``), so browse
    / download / delete pass straight through untouched.
    """
    if not (sub_path or "").lower().startswith("upload"):
        return REFLECT_CONTINUE_LOCAL

    from starlette.datastructures import UploadFile  # noqa: PLC0415

    from flow_sdk.request_context.methods import get_current_request_info  # noqa: PLC0415

    request_info = get_current_request_info()
    if request_info is None:
        return REFLECT_CONTINUE_LOCAL
    try:
        post_data = await request_info.get_post_data()
    except Exception:  # noqa: BLE001
        return REFLECT_CONTINUE_LOCAL

    files: list[UploadFile] = []
    if isinstance(post_data, dict):
        for value in post_data.values():
            if isinstance(value, UploadFile):
                files.append(value)
            elif isinstance(value, list):
                files.extend(v for v in value if isinstance(v, UploadFile))

    for f in files:
        if not f.filename:
            continue
        content = await f.read()
        # The local handler reads these same objects afterwards — rewind, or it
        # writes an empty file into the cache.
        await f.seek(0)
        await hub_post(
            et,
            {},
            hub_id,
            "fs",
            sub_path,
            files={"uploaded_file": (f.filename, content, f.content_type or "application/octet-stream")},
        )
    return REFLECT_CONTINUE_LOCAL


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
    # Entity files ride the same reflection as entity fields, but write-through
    # rather than replace — see ``_reflect_fs_to_hub``.
    if a.action_name == "fs":
        return await _reflect_fs_to_hub(et, hub_id, sub_path)
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
    ``user_picture``; the client and the ``Entity.members`` roster cache
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

# Collection fields that carry their OWN dedicated sync path and must never be
# overwritten by a bare entity PUT response: the roster (``participants`` /
# ``members`` — owned by the ``members`` reflect, and echoed in the hub's
# ``{user_id,…}`` shape rather than the local normalized ``{email,name}``) and
# the conversation message projections (rebuilt from the pointer log, guarded
# again downstream by ``apply_field_updates``). Every OTHER hub-modeled field —
# scalars AND collections the hub genuinely owns (a task's ``artifacts``,
# ``tags``, ``links``, ``metadata``) — is hub-authoritative and merges.
_MERGE_SKIP_FIELDS = frozenset({"participants", "members", "message_ids", "message_count"})


def _merge_hub_entity_into_local(entity: Entity, hub_resp: Any) -> dict[str, Any]:
    """Select the hub-authoritative fields to merge onto the local entity.

    A reflected ``update`` returns the hub's view of the entity, and the hub is
    the source of truth: every API field the hub echoes (scalar OR collection)
    that differs from the local value is applied, so a remote entity reflects
    IMMEDIATELY into the local row — including hub-modeled collections like a
    task's ``artifacts``. The only exclusions are ``_MERGE_SKIP_FIELDS`` (the
    roster + message projections, which own their own sync and carry a divergent
    hub shape). Local-only fields (``project_id``, ``dismissed_at``,
    ``archived_at``, a task's ``session_id`` …) are absent from the hub response
    → preserved untouched. Anything the hub doesn't model doesn't reflect — the
    fix for a field that SHOULD travel is to model it on the hub, not to
    re-apply it locally from the request body.

    Returns the dict of fields to apply, empty when nothing changed (so the caller
    skips the save+broadcast entirely).
    """
    if not isinstance(hub_resp, dict):
        return {}
    updates: dict[str, Any] = {}
    for k, v in hub_resp.items():
        if k in _MERGE_SKIP_FIELDS:
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

    # Generic shape: the ``members`` action returns the roster list → mirror it
    # onto ``entity.members`` (the roster cache, now on the Entity base so this
    # fires for every remote type — org/team included, not just conversation/
    # project which previously declared their own field).
    if action_name == "members" and isinstance(hub_resp, list):
        if hasattr(entity, "members"):
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
                current = list(getattr(entity, "members", None) or [])
                if current == new_participants:
                    return
                entity.members = new_participants
                # Best-effort save; never blow up the action if persistence fails.
                save = getattr(entity, "save", None)
                if callable(save):
                    await save()
            except Exception as e:  # noqa: BLE001
                logger.debug("[hub-reflect] mirror save failed for %s: %s", entity.type, e)
