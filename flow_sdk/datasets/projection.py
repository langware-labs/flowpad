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
import re
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


# ── write-through: a change to an outside-owned field goes to the outside system ──────────────────

_WRITABLE = re.compile(r"data\.([A-Za-z_][A-Za-z0-9_]*)")


async def mirror_of(dataset: Any) -> Any:
    """The data source that mirrors into ``dataset``, or None."""
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415

    folder = Path(dataset._folder()).resolve()
    for source in await DataSource.get_all({}) or []:
        if not source.mirror:
            continue
        try:
            found = dataset_of(source)
        except LookupError:
            continue
        if found is not None and Path(found._folder()).resolve() == folder:
            return source
    return None


def _refused(code: str, message: str, path: str = "") -> Exception:
    from flow_sdk.builtin.dataset import LinkError  # noqa: PLC0415

    return LinkError([{"path": path, "code": code, "message": message}])


def _outside_id(ref: Any, by: str, owner: Path) -> Any:
    """The outside system's id a link stands for: the linked row's ``by`` field."""
    from flow_sdk.builtin.dataset import Dataset  # noqa: PLC0415

    found = Dataset.find_row(ref, owner) if isinstance(ref, str) else None
    if found is None:
        return None
    dataset, key = found
    row = next((r for r in dataset.rows()["rows"] if r["key"] == key), None)
    return (row or {}).get("input", {}).get(by)


def outside_changes(shape: dict, fields: dict, owner: Path) -> dict:
    """``fields`` (row fields the outside system owns, as the app wrote them) as the outside system's
    own fields -- the map read backwards. Only ``data.<name>`` paths, and links over one, go back;
    any other is refused (``not_writable``)."""
    changes, refused = {}, []
    for name, value in fields.items():
        spec = shape["input"].get(name)
        path = spec["path"] if isinstance(spec, dict) and set(spec) == {"link", "by", "path"} else spec
        match = _WRITABLE.fullmatch(path.removesuffix(".*")) if isinstance(path, str) else None
        if match is None:
            refused.append({"path": f"input.{name}", "code": "not_writable",
                            "message": f"{name} comes from the outside system through {spec!r}, which a change cannot go back through"})
        elif isinstance(spec, dict):
            ids = [_outside_id(ref, spec["by"], owner) for ref in (value if isinstance(value, list) else [value]) if ref]
            changes[match.group(1)] = ids if isinstance(value, list) else (ids[0] if ids else None)
        else:
            changes[match.group(1)] = value
    if refused:
        from flow_sdk.builtin.dataset import LinkError  # noqa: PLC0415

        raise LinkError(refused)
    return changes


async def _item_of(source: Any, shape: dict, held: Any) -> Any:
    """The record of ``source`` whose key path holds ``held`` (the row's key field)."""
    from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415
    from flow_sdk.datasets.query import field_of  # noqa: PLC0415

    for item in await SourceItem.get_all({"data_source_id": str(source.id)}) or []:
        if field_of(item.model_dump(mode="json"), shape["key"]) == held:
            return item
    return None


async def write_through(dataset: Any, rows: list[tuple[Optional[str], dict]], by: Optional[str],
                        expected: Optional[dict] = None) -> Optional[tuple[list[tuple[str, dict]], str]]:
    """Send what ``rows`` change in outside-owned fields to the outside system, before the rows are
    written here. ``rows`` are ``(key, row)`` -- ``key`` None for a new row. None when nothing here
    applies (no source mirrors into ``dataset``, the writer writes AS that system, no row changes a
    field it owns, or the source cannot write -- the plain write then refuses as ``owned``).

    Otherwise every row is checked first (as a write by that system would be); then each change goes
    through the source (``create_item`` / ``update_item``), the dataset is re-mirrored, and the
    answer is the rows to write here -- ``(key, row)`` with the outside-owned fields as the outside
    system now has them and the app's own as written -- and the name to write them as. A refusal from
    the outside system is ``LinkError`` code ``source_refused``; nothing more is sent."""
    from flow_sdk.builtin.dataset import ConflictError, LinkError  # noqa: PLC0415

    source = await mirror_of(dataset)
    if source is None:
        return None
    shape, as_ = source.mirror["map"], source.mirror.get("by") or source.provider
    if by == as_:
        return None
    owned = {name for name, who in (getattr(dataset.row_type.input_type(), "__owned__", None) or {}).items() if who == as_}
    have = {row["key"]: row for row in dataset.rows()["rows"]}
    plan = []
    for key, row in rows:
        old = (have.get(key) or {}).get("input") if key else None
        new = row.get("input") if isinstance(row.get("input"), dict) else {}
        if old is None:
            sent = {f: v for f, v in new.items() if f in owned and v not in (None, "", [], {})}
        else:
            sent = {f: new.get(f) for f in owned if f in new and new.get(f) != old.get(f)}
        plan.append((key, row, old, sent))
    if not any(sent for *_, sent in plan):
        return None
    owner = Path(dataset._owner())
    for key, row, old, sent in plan:
        if key and (expected or {}).get(key) not in (None, have.get(key, {}).get("version")):
            raise ConflictError(f"row {key!r} changed since version {expected[key]}")
        details = dataset.check_details({**({"key": key} if old is not None else {}), **row}, by=as_)
        if details:
            raise LinkError([{**d, "path": f"{key}.{d['path']}" if key and len(rows) > 1 else d["path"]} for d in details])
        outside_changes(shape, sent, owner)             # refuses a field that cannot go back, before any I/O
    key_field_, held_at = key_field(shape), {}
    try:
        for n, (key, row, old, sent) in enumerate(plan):
            if not sent:
                continue
            changes = outside_changes(shape, sent, owner)
            if old is None:
                done = await source.create_item(changes)
            else:
                item = await _item_of(source, shape, old.get(key_field_))
                if item is None:
                    raise _refused("source_refused", f"row {key!r} has no record in {source.provider} yet: sync the source first")
                done = await source.update_item(str(item.id), changes)
            held_at[n] = await _key_value(done["item_id"], shape)
    except (PermissionError, NotImplementedError):
        if not held_at:
            return None                                  # the source cannot write: the plain write says `owned`
        raise
    except LinkError:
        raise
    except Exception as exc:  # noqa: BLE001 -- whatever the outside system said, as one refusal
        raise _refused("source_refused", f"{source.provider} refused the change: {exc}") from exc
    await project_source(source)
    now = {row["input"].get(key_field_): row for row in dataset.rows()["rows"]}
    out = []
    for n, (key, row, old, sent) in enumerate(plan):
        mirrored = now.get(held_at[n]) if n in held_at else None
        if mirrored is None:
            out.append((key, row))
            continue
        mine = {f: v for f, v in (row.get("input") or {}).items() if f not in owned}
        out.append((mirrored["key"], {**row, "input": {**mirrored["input"], **mine}}))
    return out, as_


async def _key_value(item_id: str, shape: dict) -> Any:
    from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415
    from flow_sdk.datasets.query import field_of  # noqa: PLC0415

    item = await SourceItem.get_by_id(item_id)
    return field_of(item.model_dump(mode="json"), shape["key"]) if item is not None else None


async def delete_through(dataset: Any, keys: list[str]) -> Optional[list[str]]:
    """Remove the records behind ``keys`` from the outside system, then the rows. None when no source
    mirrors into ``dataset`` (the plain delete applies). A row others still link to is refused
    before any I/O, as the plain delete refuses it; a source that cannot delete refuses as
    ``owned`` -- the row would only come back with the next sync."""
    from flow_sdk.builtin.dataset import LinkError  # noqa: PLC0415

    source = await mirror_of(dataset)
    if source is None:
        return None
    shape, key_field_ = source.mirror["map"], key_field(source.mirror["map"])
    have = {row["key"]: row for row in dataset.rows()["rows"]}
    missing = [k for k in keys if k not in have]
    if missing:
        raise LookupError(f"no example {', '.join(missing)}")
    going = set(keys)
    held = [{"path": k if len(keys) > 1 else "", "code": "referenced", "message": f"used by {', '.join(u['kind'] + ' ' + u['key'] for u in still)}"}
            for k, users in dataset.used_by(keys).items()
            if (still := [u for u in users if not (u.get("dataset_id") == dataset.id and u["key"] in going)])]
    if held:
        raise LinkError(held)
    try:
        for key in keys:
            item = await _item_of(source, shape, have[key]["input"].get(key_field_))
            if item is not None:
                await source.delete_item(str(item.id))
    except (PermissionError, NotImplementedError) as exc:
        raise _refused("owned", f"these rows are {source.provider}'s: {exc}") from exc
    except LookupError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise _refused("source_refused", f"{source.provider} refused the delete: {exc}") from exc
    return dataset.delete_rows(keys)
