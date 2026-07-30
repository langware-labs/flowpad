"""How a task materializes on the machine that RECEIVES it — group or not.

This is the task primitive's hub→local boundary, and it has nothing to do with
groups: every inbound task lands here, whether it was assigned to one person,
fanned out to a contacts group, or pushed by the hub bridge as a live op. It
lived inside ``group_task_action`` for historical reasons — single-assignee
assignment used to be implemented as "a group of one", so the group module ended
up owning the generic reception path that ``hub_bridge`` and
``flow_message_action`` both import.

Dependency direction is one-way: ``group_task_action`` imports from here, never
the reverse.

Two rules the callers depend on:

* the hub's ``asset_ref`` is the SENDER's absolute path and never binds local
  storage — it is dropped, and placement is re-derived locally (a member task
  gets the deduped ``--m-<id8>`` folder so it can't claim its parent's);
* an existing row is refreshed LWW (``Entity.is_stale``) on hub-owned fields
  only, and a blob field the hub sent EMPTY never blanks a body we already hold.
"""

from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from flow_sdk._compat import UTC
from flow_sdk.builtin.task import Task
from flow_sdk.cloud_client.transport.hub_http import hub_get
from flow_sdk.core.entity.entity_model import remote_reflection
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.fs_store.path_utils import canonical_posix_path

logger = logging.getLogger(__name__)


def _safe_task_folder_name(title: str | None) -> str:
    """Folder-safe slug of a task title — mirrors ``FSRecord._safe_name``."""
    raw = (title or "").strip().lower()
    out = "".join(c if (c.isalnum() or c in "_-") else "_" for c in raw)
    return out or "untitled"


def _member_asset_ref(parent_asset_ref: str | None, title: str | None, child_id: str | None) -> str | None:
    """Deduped folder for a member task: ``tasks/<safe_title>--m-<id8>/``.

    Every member task clones the parent title, and the default asset_ref is
    derived from the title — an un-suffixed child would claim the PARENT's
    folder, and ``owns_main_ref`` would then rewrite the parent's ``task.md``.
    Must be pre-set before the child's first save on BOTH sides (owner create
    and member materialize); ``Entity._prepare_for_storage`` honors it.
    """
    if not parent_asset_ref or not child_id:
        return None
    base = Path(str(parent_asset_ref).rstrip("/"))
    return canonical_posix_path(base.parent / f"{_safe_task_folder_name(title)}--m-{child_id[:8]}")


async def materialize_remote_task(
    data: dict[str, Any],
    someone_typeid,
    *,
    parent_ref: str | None = None,
    notify: bool = True,
) -> Optional[Task]:
    """Upsert a hub task dict as a local ``remote=True`` Task row.

    ``parent_ref`` (the local parent mirror's asset_ref) triggers the deduped
    member-folder pre-set when the payload carries ``parent_id``. Existing rows
    are refreshed LWW (``is_stale``) on the hub-owned fields only — never the
    locally-authoritative asset path.
    """
    if not isinstance(data, dict):
        return None
    ent_id = str(data.get("id") or "").strip()
    if not ent_id:
        return None

    # Drop everything the hub may not dictate — PRIVATE (never accepted) plus
    # HUB_WRITE (per-device state). This replaces a hand-written
    # `sanitized.pop("asset_ref")` ("hub paths never bind local storage"): the
    # same rule, now stated once on the field instead of per call site, and it
    # covers the CREATE branch below as well as the merge.
    blocked = Task.fields_not_accepted_from_hub()
    sanitized = {k: v for k, v in data.items() if Task.is_api_field(k) and k not in blocked}
    sanitized["id"] = ent_id

    existing = await Task.get_one({"id": ent_id})
    if existing is None:
        ent = Task.model_validate(sanitized)
        ent.remote = True
        if data.get("parent_id"):
            ref = _member_asset_ref(parent_ref, ent.title, ent_id)
            if ref:
                ent.asset_ref = ref
        with remote_reflection():
            ent = await ent.save(someone_typeid, notify=notify)
        return ent

    if not Task.is_stale(existing, data):
        return existing
    updates: dict[str, Any] = {}
    # A payload built from the hub's DB row carries blob fields EMPTY (they're
    # db-excluded), and "" is not None — merging it would blank a body we hold.
    # The bridge refills them when it can (``hub_bridge._fill_empty_blobs``);
    # this is the backstop for every other caller.
    blob_fields = set(Task.get_blob_fields_names() or [])
    # Derived from the field declarations: everything PRIVATE (never accepted
    # from outside) or HUB_WRITE (per-device state). Restating a copy here would
    # go stale the next time a field's policy changes.
    keep_local = {"id"} | blocked
    for k, v in sanitized.items():
        if k in keep_local or v is None:
            continue
        if k in blob_fields and v == "" and getattr(existing, k, None):
            continue
        if getattr(existing, k, None) != v:
            updates[k] = v
    if updates:
        # Hub projections include typed API metadata such as
        # ``expand={"expansions": ["blobs"]}``.  Assigning those JSON values
        # directly bypasses Pydantic and leaves an invalid dict on the live
        # entity; the next blob save then expects ``EntityExpansion`` and
        # crashes.  Reuse the entity's validated update seam for the whole
        # hub-owned delta.
        existing.apply_field_updates(updates)
    changed = bool(updates)
    if not existing.remote:
        existing.remote = True
        changed = True
    if changed:
        existing.fetched_at = datetime.now(UTC)
        with remote_reflection():
            existing = await existing.save(someone_typeid, notify=notify)
    return existing


async def materialize_accepted_task_invitation(target_id: str, someone_typeid) -> Optional[Task]:
    """Accept-side materialization for a member-task invitation.

    The invitation carries TWO task targets (member task + group parent) and
    the hub resolves an arbitrary one as the inbox target — so handle both:

    - handed the CHILD (has ``parent_id``): pull + materialize the parent
      first (its asset_ref anchors the child's deduped folder), then the child;
    - handed the PARENT: materialize it, then pull its hub children — the
      listing is access-filtered, so a member only ever receives their own
      member task — and materialize those.

    A single-assignee assignment has no child at all: it arrives as the parent
    branch with an empty child listing, and the task itself is the result.

    Called from ``handle_invitation_accept``.
    """
    hub_task = await hub_get(BuiltinEntityType.TASK, target_id, params={"expand": "blobs"})
    if not isinstance(hub_task, dict) or not hub_task.get("id"):
        return None

    parent_id = hub_task.get("parent_id")
    if parent_id:
        parent: Optional[Task] = None
        hub_parent = await hub_get(BuiltinEntityType.TASK, str(parent_id), params={"expand": "blobs"})
        if isinstance(hub_parent, dict) and hub_parent.get("id"):
            parent = await materialize_remote_task(hub_parent, someone_typeid)
        child = await materialize_remote_task(
            hub_task, someone_typeid, parent_ref=(parent.asset_ref if parent else None)
        )
        if parent is not None:
            await _notify_quietly(parent)
        return child

    parent = await materialize_remote_task(hub_task, someone_typeid)
    if parent is None:
        return None
    children = await hub_get(BuiltinEntityType.TASK, target_id, action=Task.get_type(), params={"expand": "blobs"})
    child_list = children if isinstance(children, list) else []
    child: Optional[Task] = None
    for raw in child_list:
        if not isinstance(raw, dict) or not raw.get("id"):
            continue
        materialized = await materialize_remote_task(raw, someone_typeid, parent_ref=parent.asset_ref)
        child = child or materialized
    await _notify_quietly(parent)
    return child or parent


async def _notify_quietly(entity: Task) -> None:
    try:
        await entity.notify_updated()
    except Exception as e:  # noqa: BLE001
        logger.warning("[task-receive] notify failed (non-fatal): %s", e)
