"""THE per-app lifecycle record (``webapp.lifecycle``): read, change, push.

One file per app per instance, ``<records data root>/micro_app/<id>/lifecycle.json`` — beside the app's other
instance data, never in the app's folder (it is this machine's state, not the app's). A change is a
read-modify-write under the file's cross-process lock, then one push: the ``WebApp`` row is announced, and its
``lifecycle`` field (computed from this file on every serialization) carries the new record to every screen
watching it. Nothing else holds a verdict: a backend restart reads this file back.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from flow_sdk.schema.data_spec.webapp_lifecycle_spec import (
    AttemptCounter,
    LifecycleState,
    WebappLifecycleSpec,
)

logger = logging.getLogger(__name__)

RECORD_FILE = "lifecycle.json"
LOCK_FILE = "lifecycle.lock"


def _bare(webapp_id: str) -> str:
    return str(webapp_id).removeprefix("micro_app-")


def path_of(webapp_id: str) -> Path:
    from flow_sdk.fs_store.record_paths import data_dir_for  # noqa: PLC0415

    return data_dir_for("micro_app", _bare(webapp_id)) / RECORD_FILE


def read(webapp_id: str, project_id: str = "") -> WebappLifecycleSpec:
    """The app's record; a fresh ``down`` one when there is none (or it cannot be read)."""
    from flow_sdk.instances.atomic import read_json  # noqa: PLC0415

    data = read_json(path_of(webapp_id))
    if data:
        try:
            return WebappLifecycleSpec.model_validate(data)
        except ValueError as exc:
            logger.warning("unreadable lifecycle record of %s: %s", webapp_id, exc)
    return WebappLifecycleSpec(webapp_id=_bare(webapp_id), project_id=str(project_id or ""))


def _write(webapp_id: str, project_id: str, changes: dict[str, Any]) -> tuple[WebappLifecycleSpec, bool]:
    from flow_sdk.instances.atomic import locked, write_json_atomic  # noqa: PLC0415

    path = path_of(webapp_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    with locked(path.parent / LOCK_FILE):
        before = read(webapp_id, project_id)
        now = datetime.now(timezone.utc)
        update = dict(changes)
        if "state" in update and update["state"] != before.state:
            update.setdefault("since", now)
        if project_id and not before.project_id:
            update.setdefault("project_id", str(project_id))
        after = before.model_copy(update=update)
        after = WebappLifecycleSpec.model_validate(after.model_dump(mode="json"))
        changed = after.model_dump(mode="json", exclude={"checked_at"}) != before.model_dump(
            mode="json", exclude={"checked_at"})
        if changed or "checked_at" in update:
            write_json_atomic(path, after.model_dump(mode="json"))
    return after, changed


async def change(webapp_id: str, *, project_id: str = "", push: bool = True, **changes: Any) -> WebappLifecycleSpec:
    """Apply ``changes`` to the app's record and, when it changed, push it to every screen watching the app."""
    after, changed = await asyncio.to_thread(_write, webapp_id, project_id, changes)
    if changed and push:
        await announce(webapp_id)
    return after


async def set_state(webapp_id: str, state: LifecycleState, detail: str = "", *, project_id: str = "",
                    **changes: Any) -> WebappLifecycleSpec:
    """The app is now in ``state`` (``detail``: what it is doing, in one line)."""
    return await change(webapp_id, project_id=project_id, state=state, detail=detail, **changes)


def bumped(record: WebappLifecycleSpec, fingerprint: str, **counts: Any) -> list[AttemptCounter]:
    """``record.attempts`` with ``fingerprint``'s counter changed: ``handled=1`` adds one; other keys are set."""
    current = record.counter(fingerprint)
    update = {}
    for key, value in counts.items():
        if key in ("handled", "deterministic", "agent") and isinstance(value, int):
            update[key] = getattr(current, key) + value
        else:
            update[key] = value
    fresh = current.model_copy(update=update)
    return [c for c in record.attempts if c.fingerprint != fingerprint] + [fresh]


async def announce(webapp_id: str) -> None:
    """Push the app's row (and so its ``lifecycle``) to every screen watching it. Best effort."""
    try:
        from flow_sdk.builtin.faas.micro_app import WebApp  # noqa: PLC0415

        app = await WebApp.get_by_id(_bare(webapp_id))
        if app is not None:
            await app.notify_updated()
    except Exception as exc:  # noqa: BLE001 — a screen missing a push re-reads the record; never a failed change
        logger.debug("lifecycle push of %s failed: %s", webapp_id, exc)


def forget(webapp_id: str) -> None:
    """Drop the app's record (the app was removed)."""
    try:
        path_of(webapp_id).unlink(missing_ok=True)
    except OSError:
        pass


__all__ = ["announce", "bumped", "change", "forget", "path_of", "read", "set_state"]
