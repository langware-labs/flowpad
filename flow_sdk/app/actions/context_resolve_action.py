"""Reconcile an entity's context-entity references against local + hub state.

``ContextEntityChip`` renders every entry in an entity's
``shared_context_entities`` / ``private_context_entities`` buckets. When a target
typeid has no local row the chip 404s. A local 404 is NOT proof the target is
gone — remote/shared entities live on the hub and are fetched from there; the
local row is simply not materialized on this receiver. So "truly gone" can only
be decided by checking **local AND hub**.

This action does that classification and, only for refs that are absent in BOTH
places AND whose holder is local-origin (``remote == False``), prunes the dead
reference. It never mutates a ``remote == True`` holder (a received
FlowMessage / Conversation) — its ``shared_context_entities`` is hub-authoritative
and a local unshare would be overwritten on the next sync — and it never touches
*implicit* private entries (e.g. the ``project_id`` projection), which aren't in
the explicit storage and must be fixed at their source field, not here.

Wire shape:

  POST /api/v1/graph/<type>/<id>/reconcile-context
  →    {"ok": <bool>, "removed": [...], "remote_present": [...],
        "indeterminate": [...], "holder_remote": <bool>}

On a successful prune the holder emits a ``context_refs_cleaned`` entity event so
open watchers drop the chips live without a reload.
"""
from __future__ import annotations

import logging

from flow_sdk.actions import action

# Reuse the target-loader so the holder is bound to the active storage scope
# (required by the save path) — identical to the share/unshare actions.
from flow_sdk.app.actions.context_share_action import _resolve_target_entity
from flow_sdk.cloud_client.transport.hub_http import hub_resolve_by_typeid
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)


async def _exists_locally(t: TypeId) -> bool | None:
    """True/False if the entity is present locally; None when we can't tell
    (unknown type, query error) — caller treats None as "do not clean".

    Uses ``get_by_typeid`` — the same lookup the graph GET / request middleware
    use to decide a 404 — so "missing locally" here means exactly what made the
    chip 404 in the first place (not a scope-dependent query that can spuriously
    error for project-scoped types)."""
    cls = SchemaRegistry.get_entity_cls(t.type)
    if cls is None:
        return None
    try:
        found = await cls.get_by_typeid(t)
        return found is not None
    except Exception as exc:  # noqa: BLE001
        logger.warning("[reconcile-context] local existence check failed for %s: %s", t, exc)
        return None


@action.post(action_name="reconcile-context", types="all")
async def reconcile_context() -> ApiResponse:
    """Prune dead context references on the URL-targeted holder.

    For each ref in the holder's shared bucket + *explicit* private storage that
    is missing locally, probe the hub:

      * present on hub        → remote, not gone → leave it.
      * indeterminate (hub down/unset/unknown type) → leave it (conservative).
      * absent on hub (404)   → truly gone → remove, but only when the holder is
                                local-origin (``remote == False``).
    """
    entity = await _resolve_target_entity()
    request_info = get_current_request_info()
    holder_remote = bool(getattr(entity, "remote", False))

    # (typeid, bucket) pairs. Explicit private only — the computed
    # ``private_context_entities`` includes implicit projections (project_id)
    # that are NOT in ``private_context_entities_`` and must never be pruned.
    candidates: list[tuple[TypeId, str]] = []
    for t in list(entity.shared_context_entities):
        candidates.append((t, "shared"))
    for t in list(getattr(entity, "private_context_entities_", []) or []):
        candidates.append((t, "private"))

    removed: list[str] = []
    remote_present: list[str] = []
    indeterminate: list[str] = []

    for t, bucket in candidates:
        local = await _exists_locally(t)
        if local is None or local is True:
            # Unknown type / query error → leave it; present locally → not dangling.
            continue
        state, _data = await hub_resolve_by_typeid(t)
        if state == "present":
            remote_present.append(str(t))
            continue
        if state == "indeterminate":
            indeterminate.append(str(t))
            continue
        # state == "absent": truly gone everywhere.
        if holder_remote:
            # Hub-authoritative holder — a local prune is reverted on next sync.
            # Surface it (UI shows the muted chip) but never mutate locally.
            indeterminate.append(str(t))
            logger.info(
                "[reconcile-context] %s dead ref %s on remote holder — suppressed, not pruned",
                entity.typeid, t,
            )
            continue
        if bucket == "shared":
            entity.remove_shared_context_entities(t)
        else:
            entity.remove_private_context_entities(t)
        removed.append(str(t))

    if removed:
        await entity.save(request_info.someone_typeid)
        try:
            await entity.emit_entity_event("context_refs_cleaned", {"removed": removed})
        except Exception as exc:  # noqa: BLE001
            logger.warning("[reconcile-context] emit context_refs_cleaned failed (non-fatal): %s", exc)

    return ApiSuccessResponse(
        data={
            "ok": bool(removed),
            "removed": removed,
            "remote_present": remote_present,
            "indeterminate": indeterminate,
            "holder_remote": holder_remote,
        }
    )
