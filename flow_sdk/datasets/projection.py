"""A data source's records projected into a dataset's rows -- the DECLARED mirror.

``SourceItem`` is the cache of a system of record; a dataset row is how an app models it (kinds,
links, rules). A source that names a dataset in its ``mirror`` (``data_source.json``)::

    "mirror": {"dataset": "tasks", "map": {"key": "external_id", "input": {...}}, "by": "crm"}

has that dataset made the mirror of its records after every sync (``Dataset.mirror``, the same call
a script makes by hand). The source decides where its records go, as it decides ``reflect``; this
module is the one place that knows both halves, as ``stream_inbox/projection`` is for messages.

**One sweep per source at a time.** Every pass ends in ``ingest.<provider>.sync.completed``; a sync
that completes while a sweep runs buys one more round, never a pile of them. ``prune`` is the
mirror's default: it reads every record the store keeps, and a stored record goes only when the
source proved it gone (``lists_everything``), so a row goes only with its record.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any, Optional

from flow_sdk.stream_inbox._locks import new_registry

logger = logging.getLogger(__name__)

_sweeps = new_registry()
_started = False


def check_mirror(value: Any) -> Optional[dict]:
    """A source's ``mirror`` as declared, or ``ValueError`` saying what is wrong with it: a dataset
    name, a map (``{"key": <path>, "input": {...}}``) whose key path is also mapped to a field -- how a
    row finds its record again -- and an optional ``by``."""
    if value in (None, {}):
        return None
    if not isinstance(value, dict) or set(value) - {"dataset", "map", "by"}:
        raise ValueError('mirror: {"dataset", "map", "by"?} is required')
    if not isinstance(value.get("dataset"), str) or not value["dataset"].strip() or "/" in value["dataset"]:
        raise ValueError("mirror.dataset: the name of a dataset folder of this project is required")
    shape = value.get("map")
    if not isinstance(shape, dict) or not isinstance(shape.get("key"), str) or not isinstance(shape.get("input"), dict):
        raise ValueError('mirror.map: {"key": <path>, "input": {<field>: <path>}} is required')
    if key_field(shape) is None:
        raise ValueError(f"mirror.map: map the key path {shape['key']!r} to a field too: it is how a row finds its record again")
    if value.get("by") is not None and not isinstance(value["by"], str):
        raise ValueError("mirror.by: the name the rows are written as is a string")
    return value


def key_field(shape: dict) -> Optional[str]:
    """The row field the map's key path is mapped to (``crm_id`` for ``"crm_id": "external_id"``)."""
    return next((name for name, path in shape["input"].items() if path == shape["key"]), None)


def dataset_of(source: Any) -> Any:
    """The dataset a source mirrors into, beside it in its project -- None when it declares none.
    ``LookupError`` when it names one its project does not hold."""
    from flow_sdk.builtin.dataset import Dataset  # noqa: PLC0415

    mirror = getattr(source, "mirror", None)
    if not mirror:
        return None
    if not source.asset_ref:
        raise LookupError(f"data source {source.name!r} has no folder, so no project to find {mirror['dataset']!r} in")
    folder = Path(source.asset_ref).parent.parent.parent / "agentic-assets" / "dataset" / mirror["dataset"]
    if not (folder / "dataset.json").is_file():
        raise LookupError(f"data source {source.name!r} mirrors into {mirror['dataset']!r}, which its project does not hold")
    return Dataset.at(folder)


async def project_source(source: Any) -> Optional[dict]:
    """Make the source's dataset the mirror of its records now -- what ``Dataset.mirror`` answers, or
    None for a source that declares no mirror."""
    dataset = dataset_of(source)
    if dataset is None:
        return None
    mirror = source.mirror
    return await dataset.mirror(source, mirror["map"], by=mirror.get("by") or source.provider)


async def _project(source_id: str) -> None:
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415

    source = await DataSource.get_by_id(source_id)
    if source is not None and source.mirror:
        done = await project_source(source)
        logger.info("[mirror] %s → %s: %s", source.name, source.mirror["dataset"],
                    {k: len(v) if isinstance(v, list) else v for k, v in (done or {}).items()})


async def _on_sync(event: Any) -> None:
    """One sweep per source at a time; a sync that completes during it buys ONE more round."""
    source_id = str((getattr(event, "data", None) or {}).get("source_id") or "")
    if not source_id:
        return
    pending = _sweeps.setdefault(asyncio.get_running_loop(), {})
    if source_id in pending:
        pending[source_id] = True
        return
    pending[source_id] = False
    try:
        while True:
            try:
                await _project(source_id)
            except Exception:  # noqa: BLE001 -- a broken mirror is logged; the next sync tries again
                logger.exception("[mirror] projecting source %s failed", source_id)
            if not pending[source_id]:
                return
            pending[source_id] = False
    finally:
        pending.pop(source_id, None)


def start_dataset_projection() -> None:
    """Subscribe the declared mirrors to every source's ``sync.completed``. Idempotent."""
    global _started
    if _started:
        return
    _started = True
    from flow_sdk.tags import on_tag  # noqa: PLC0415

    on_tag("ingest.*.sync.completed", _on_sync)
