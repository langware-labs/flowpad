"""Per-project, per-device state that must never ride the Project row.

A Project field is round-tripped by every UI ``project.save()`` (view-mode
stamping on each open), so a stale copy in flight can silently wipe a flag the
backend just set. State that only this device cares about — "did X already
fire for project P here" — lives in a small JSON file under the instance dir
instead: nothing else reads or writes it, and a shared project (or the box
behind a sandbox handover) gets its own copy by construction.

One file per project, keyed by feature, so the next such flag rides the same
file rather than minting another private directory.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from flow_sdk.instances.atomic import read_json, write_json_atomic


def _state_path(project_id: str) -> Path:
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    return get_instance_settings().instance_dir / "projects" / project_id / "device_state.json"


def read_project_device_state(project_id: str) -> dict[str, Any]:
    """The whole state object; ``{}`` when missing or corrupt."""
    return read_json(_state_path(project_id))


def update_project_device_state(project_id: str, **fields: Any) -> dict[str, Any]:
    """Merge ``fields`` into the project's state and write it back atomically."""
    state = {**read_project_device_state(project_id), **fields}
    write_json_atomic(_state_path(project_id), state)
    return state
