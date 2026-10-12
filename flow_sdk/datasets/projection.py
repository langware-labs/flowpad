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

import logging
import re
from pathlib import Path
from typing import Any, Optional

from flow_sdk.stream_inbox._locks import new_registry, single_flight

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
    if source_id:
        await single_flight(_sweeps, source_id, lambda: _project(source_id), "[mirror] projecting source %s failed")


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


def is_link(spec: Any) -> bool:
    """A map entry that makes the outside system's id a link: ``{"link", "by", "path"}``."""
    return isinstance(spec, dict) and set(spec) == {"link", "by", "path"}


def _owned(dataset: Any) -> dict:
    return getattr(dataset.row_type.input_type(), "__owned__", None) or {}


async def mirror_of(dataset: Any) -> Any:
    """The data source that mirrors into ``dataset``, or None -- asked of the index for the sources
    of the dataset's own project only (a mirror names a dataset beside it)."""
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415
    from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415
    from flow_sdk.fs_store.path_utils import asset_refs_under  # noqa: PLC0415

    folder = Path(dataset._folder()).resolve()
    sources = Path(dataset._owner()).resolve() / "agentic-assets" / "data_source"
    likes = [ExpressionNode(op=QueryOp.LIKE, operands=["asset_ref", pattern]) for pattern in asset_refs_under(str(sources))]
    match = likes[0] if len(likes) == 1 else ExpressionNode(op=QueryOp.OR, operands=likes)
    for source in await DataSource.get_all(QueryFilter(match=match)) or []:
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


def outside_changes(shape: dict, fields: dict, owner: Path, links: dict) -> dict:
    """``fields`` (row fields the outside system owns, as the app wrote them) as the outside system's
    own fields -- the map read backwards. Only ``data.<name>`` paths, and links over one (sent as the
    linked rows' ``by`` field), go back; any other is refused (``not_writable``). ``links`` remembers
    the linked rows read across calls."""
    from flow_sdk.builtin.dataset import Dataset, LinkError  # noqa: PLC0415

    def outside_id(ref: Any, by: str) -> Any:
        if (ref, by) not in links:
            found = Dataset.find_row(ref, owner) if isinstance(ref, str) else None
            rows = found[0].rows({"key": found[1]})["rows"] if found else []
            links[(ref, by)] = rows[0]["input"].get(by) if rows else None
        return links[(ref, by)]

    changes, refused = {}, []
    for name, value in fields.items():
        spec = shape["input"].get(name)
        path = spec["path"] if is_link(spec) else spec
        match = _WRITABLE.fullmatch(path.removesuffix(".*")) if isinstance(path, str) else None
        if match is None:
            refused.append({"path": f"input.{name}", "code": "not_writable",
                            "message": f"{name} comes from the outside system through {spec!r}, which a change cannot go back through"})
        elif is_link(spec):
            ids = [outside_id(ref, spec["by"]) for ref in (value if isinstance(value, list) else [value]) if ref]
            changes[match.group(1)] = ids if isinstance(value, list) else (ids[0] if ids else None)
        else:
            changes[match.group(1)] = value
    if refused:
        raise LinkError(refused)
    return changes


async def _records(source: Any, shape: dict) -> dict:
    """``{key path value: record}`` over the source's records -- read once per write."""
    from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415
    from flow_sdk.datasets.query import field_of  # noqa: PLC0415

    return {field_of(item.model_dump(mode="json"), shape["key"]): item
            for item in await SourceItem.get_all({"data_source_id": str(source.id)}) or []}


_ORIGIN_KEY = ("external_id", "origin.key", "origin_key")


async def _key_of(done: dict, shape: dict) -> Any:
    """What the map's key path holds for the record a write-back answered: its origin's key for the
    usual key paths, else read from the record kept."""
    if shape["key"] in _ORIGIN_KEY:
        return done["origin"]["key"]
    from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415
    from flow_sdk.datasets.query import field_of  # noqa: PLC0415

    item = await SourceItem.get_by_id(done["item_id"])
    return field_of(item.model_dump(mode="json"), shape["key"]) if item is not None else None


async def write_through(dataset: Any, rows: list[tuple[Optional[str], dict]], by: Optional[str],
                        expected: Optional[dict] = None) -> Optional[tuple[list[tuple[str, dict]], str]]:
    """Send what ``rows`` change in outside-owned fields to the outside system, before the rows are
    written here. ``rows`` are ``(key, row)`` -- ``key`` None for a new row. None when nothing here
    applies (the row kind owns nothing, no source mirrors into ``dataset``, the writer writes AS that
    system, no row changes a field it owns, or the source cannot write -- the plain write then
    refuses as ``owned``).

    Otherwise every row is checked first (as a write by that system would be); then each change goes
    through the source (``create_item`` / ``update_item``), the dataset is re-mirrored, and the
    answer is the rows to write here -- ``(key, row)`` with the outside-owned fields as the outside
    system now has them and the app's own as written -- and the name to write them as. A refusal from
    the outside system is ``LinkError`` code ``source_refused``; nothing more is sent."""
    from flow_sdk.builtin.dataset import ConflictError, LinkError  # noqa: PLC0415

    if not _owned(dataset):
        return None                                      # nothing here is anyone else's: no I/O at all
    source = await mirror_of(dataset)
    if source is None:
        return None
    shape, as_ = source.mirror["map"], source.mirror.get("by") or source.provider
    if by == as_:
        return None
    owned = {name for name, who in _owned(dataset).items() if who == as_}
    have = {row["key"]: row for row in dataset.rows()["rows"]}
    owner, links, checked = Path(dataset._owner()), {}, {}
    plan = []
    for key, row in rows:
        old = (have.get(key) or {}).get("input") if key else None
        new = row.get("input") if isinstance(row.get("input"), dict) else {}
        if old is None:
            sent = {f: v for f, v in new.items() if f in owned and v not in (None, "", [], {})}
        else:
            sent = {f: new.get(f) for f in owned if f in new and new.get(f) != old.get(f)}
        plan.append([key, row, old, sent, None])
    if not any(step[3] for step in plan):
        return None
    for step in plan:
        key, row, old, sent, _ = step
        if key and (expected or {}).get(key) not in (None, have.get(key, {}).get("version")):
            raise ConflictError(f"row {key!r} changed since version {expected[key]}")
        details = dataset.check_details({**({"key": key} if old is not None else {}), **row}, cache=checked, by=as_)
        if details:
            raise LinkError([{**d, "path": f"{key}.{d['path']}" if key and len(rows) > 1 else d["path"]} for d in details])
        step[4] = outside_changes(shape, sent, owner, links) if sent else None   # refused before any I/O
    key_field_, records, sent_to = key_field(shape), None, {}
    try:
        for n, (key, row, old, sent, changes) in enumerate(plan):
            if changes is None:
                continue
            if old is None:
                done = await source.create_item(changes)
            else:
                records = records if records is not None else await _records(source, shape)
                item = records.get(old.get(key_field_))
                if item is None:
                    raise _refused("source_refused", f"row {key!r} has no record in {source.provider} yet: sync the source first")
                done = await source.update_item(str(item.id), changes)
            sent_to[n] = await _key_of(done, shape)
    except (PermissionError, NotImplementedError):
        if not sent_to:
            return None                                  # the source cannot write: the plain write says `owned`
        raise
    except LinkError:
        raise
    except Exception as exc:  # noqa: BLE001 -- whatever the outside system said, as one refusal
        raise _refused("source_refused", f"{source.provider} refused the change: {exc}") from exc
    await project_source(source)
    now = {row["input"].get(key_field_): row for row in dataset.rows()["rows"]}
    out = []
    for n, (key, row, *_rest) in enumerate(plan):
        mirrored = now.get(sent_to.get(n)) if n in sent_to else None
        if mirrored is None:
            out.append((key, row))
            continue
        mine = {f: v for f, v in (row.get("input") or {}).items() if f not in owned}
        out.append((mirrored["key"], {**row, "input": {**mirrored["input"], **mine}}))
    return out, as_


async def delete_through(dataset: Any, keys: list[str], expected: Optional[dict] = None) -> Optional[list[str]]:
    """Remove the records behind ``keys`` from the outside system, then the rows. None when no source
    mirrors into ``dataset`` (the plain delete applies). Everything the plain delete refuses -- a key
    that is no row, a row changed since ``expected``, a row others still link to -- is refused before
    any I/O; a source that cannot delete refuses as ``owned``: the row would only come back with the
    next sync."""
    if not _owned(dataset):
        return None
    source = await mirror_of(dataset)
    if source is None:
        return None
    shape = source.mirror["map"]
    with dataset._lock():
        dataset._check_delete(keys, expected or {})
    have = {row["key"]: row for row in dataset.rows()["rows"]}
    records, key_field_ = await _records(source, shape), key_field(shape)
    try:
        for key in keys:
            item = records.get(have[key]["input"].get(key_field_)) if key in have else None
            if item is not None:
                await source.delete_item(str(item.id))
    except (PermissionError, NotImplementedError) as exc:
        raise _refused("owned", f"these rows are {source.provider}'s: {exc}") from exc
    except LookupError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise _refused("source_refused", f"{source.provider} refused the delete: {exc}") from exc
    return dataset.delete_rows(keys)
