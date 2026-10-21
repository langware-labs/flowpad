"""A dataset whose rows live in a RECORD SYSTEM (``dataset.json`` ``location`` with a ``map``) --
how a row becomes a record and back.

The location's ``map`` says how a record becomes a row (``Dataset.mirror``, run on every pull of the
location: ``datasets/locations.py``); this module reads it backwards: a change to a field the record
system owns (the schema's ``owned_by``) is SENT TO THE SYSTEM FIRST (``write_through``), and a delete
removes the record first (``delete_through``) -- one way in, for the row actions and the async API.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)


def check_map(shape: Any) -> dict:
    """A record location's ``map`` as declared, or ``ValueError`` saying what is wrong with it:
    ``{"key": <path>, "input": {...}}`` whose key path is also mapped to a field -- how a row finds
    its record again."""
    if not isinstance(shape, dict) or not isinstance(shape.get("key"), str) or not isinstance(shape.get("input"), dict):
        raise ValueError('location.map: {"key": <path>, "input": {<field>: <path>}} is required')
    if key_field(shape) is None:
        raise ValueError(f"location.map: map the key path {shape['key']!r} to a field too: it is how a row finds its record again")
    return shape


def key_field(shape: dict) -> Optional[str]:
    """The row field the map's key path is mapped to (``crm_id`` for ``"crm_id": "external_id"``)."""
    return next((name for name, path in shape["input"].items() if path == shape["key"]), None)


def record_system(dataset: Any) -> Any:
    """The record system ``dataset``'s rows live in, or None (its rows are files)."""
    from flow_sdk.datasets.locations import RECORDS, RecordSystem  # noqa: PLC0415

    if not getattr(dataset, "asset_ref", None):
        return None
    location = dataset._location()
    return RecordSystem(location, dataset=dataset) if location.kind == RECORDS else None


# ── write-through: a change to an outside-owned field goes to the outside system ──────────────────

_WRITABLE = re.compile(r"data\.([A-Za-z_][A-Za-z0-9_]*)")


_EMPTY = (None, "", [], {})


#: ``"by": "key"`` in a link spec: the outside system holds the linked row's KEY (the path grammar's
#: ``key``), not a field of it -- for rows the outside system does not have (your own, tagged onto its).
ROW_KEY = "key"


def is_link(spec: Any) -> bool:
    """A map entry that makes the outside system's id a link: ``{"link", "by", "path"}``."""
    return isinstance(spec, dict) and set(spec) == {"link", "by", "path"}


def _owned(dataset: Any) -> dict:
    return getattr(dataset.row_type.input_type(), "__owned__", None) or {}


def _refused(code: str, message: str, path: str = "") -> Exception:
    from flow_sdk.builtin.dataset import LinkError  # noqa: PLC0415

    return LinkError([{"path": path, "code": code, "message": message}])


def _outside_id(ref: Any, by: str, owner: Path, links: dict) -> Any:
    """The outside system's id a linked row holds in its ``by`` field; ``links`` remembers each one."""
    from flow_sdk.builtin.dataset import Dataset  # noqa: PLC0415

    if (ref, by) not in links:
        found = Dataset.find_row(ref, owner) if isinstance(ref, str) else None
        if found and by == ROW_KEY:
            links[(ref, by)] = found[1]
        else:
            rows = found[0].query({"key": found[1]})["rows"] if found else []
            links[(ref, by)] = rows[0]["input"].get(by) if rows else None
    return links[(ref, by)]


def outside_changes(shape: dict, fields: dict, owner: Path, links: dict) -> dict:
    """``fields`` (row fields the outside system owns, as the app wrote them) as the outside system's
    own fields -- the map read backwards. Only ``data.<name>`` paths, and links over one (sent as the
    linked rows' ``by`` field), go back; any other is refused (``not_writable``). ``links`` remembers
    the linked rows read across calls."""
    from flow_sdk.builtin.dataset import LinkError  # noqa: PLC0415

    def outside_id(ref: Any, by: str) -> Any:
        return _outside_id(ref, by, owner, links)

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


_ORIGIN_KEY = ("external_id", "origin.key", "origin_key")


class _Records:
    """The system's records a write names, read one at a time by the map's key path value -- by its
    id directly for the usual key paths, else every record once, filtered."""

    def __init__(self, system: Any, shape: dict) -> None:
        self.system, self.shape, self.found, self.all = system, shape, {}, None

    async def get(self, value: Any) -> Optional[dict]:
        from flow_sdk.datasets.query import field_of  # noqa: PLC0415

        if value in self.found:
            return self.found[value]
        if self.shape["key"] in _ORIGIN_KEY:
            record = await self.system.get(value) if value not in (None, "") else None
        else:
            if self.all is None:
                self.all = {field_of(r, self.shape["key"]): r for r in await self.system.records()}
            record = self.all.get(value)
        self.found[value] = record
        return record


def _rows_by(dataset: Any, field: str, values: list) -> dict:
    """``{value: row}`` for the rows whose ``field`` (``key``, or ``input.<name>``) holds one of
    ``values`` -- ONE read, matched in the query language (``$IN``)."""
    wanted = [v for v in values if v not in (None, "")]
    if not wanted:
        return {}
    rows = dataset.query({"op": "$IN", "operands": [field, wanted]})["rows"]
    return {field_of_row(row, field): row for row in rows}


def field_of_row(row: dict, field: str) -> Any:
    """A row's ``key``, or the ``input.<name>`` the query language names."""
    return row["key"] if field == "key" else row["input"].get(field.removeprefix("input."))


def _unlinked(shape: dict, name: str, record: Optional[dict], before: Any, outside_id: Any) -> list:
    """The outside ids a list link field holds in the RECORD (dumped) that the row did not resolve (no
    row to link to when it was mirrored) -- what a write of that field would silently drop."""
    from flow_sdk.datasets.query import Many, field_of  # noqa: PLC0415

    spec = shape["input"].get(name)
    if not is_link(spec) or not spec["path"].endswith(".*") or record is None:
        return []
    theirs = field_of(record, spec["path"])
    theirs = [str(v) for v in (list(theirs) if isinstance(theirs, Many) else [theirs]) if v not in (None, "")]
    ours = {str(outside_id(ref, spec["by"])) for ref in (before or []) if ref}
    return [v for v in theirs if v not in ours]


def _key_of(done: dict, shape: dict) -> Any:
    """What the map's key path holds for the record a write answered."""
    from flow_sdk.datasets.query import field_of  # noqa: PLC0415

    return field_of(done, shape["key"])


#: A warning on a row written through: the outside system made the record, but not all of it.
SOURCE_PARTIAL = "source_partial"


async def write_through(dataset: Any, rows: list[tuple[Optional[str], dict]], by: Optional[str],
                        expected: Optional[dict] = None) -> Optional[tuple[list[tuple[str, dict]], str, list[dict]]]:
    """Send what ``rows`` change in outside-owned fields to the outside system, before the rows are
    written here. ``rows`` are ``(key, row)`` -- ``key`` None for a new row. None when nothing here
    applies (the row kind owns nothing, the rows do not live in a record system, the writer writes AS that
    system, no row changes a field it owns, or the source cannot write -- the plain write then
    refuses as ``owned``).

    Otherwise every row is checked first (as a write by that system would be); then each change goes
    through the record system (``create`` / ``update``), the rows are pulled again, and the
    answer is the rows to write here -- ``(key, row)`` with the outside-owned fields as the outside
    system now has them and the app's own as written -- the name to write them as, and the WARNINGS
    (``[{error_code: "source_partial", message, key}]``): a record the outside system made but not all
    of (``SourceItemSpec.warnings``) is still written here, and the caller is told what was not set.
    A refusal from the outside system is ``LinkError`` code ``source_refused``; nothing more is sent."""
    from flow_sdk.builtin.dataset import ConflictError, LinkError  # noqa: PLC0415

    if not any(who != by for who in _owned(dataset).values()):
        return None                                      # nothing here is anyone else's: no I/O at all
    source = record_system(dataset)
    if source is None:
        return None
    shape, as_ = source.map, source.by
    if by == as_:
        return None
    owned = {name for name, who in _owned(dataset).items() if who == as_}
    have = _rows_by(dataset, "key", [key for key, _ in rows if key])
    owner, links, checked = Path(dataset._owner()), {}, {}
    plan = []
    for key, row in rows:
        old = (have.get(key) or {}).get("input") if key else None
        new = row.get("input") if isinstance(row.get("input"), dict) else {}
        if old is None:
            sent = {f: v for f, v in new.items() if f in owned and v not in _EMPTY}
        else:
            # a put REPLACES the row's input: a field left out is a field cleared, and is sent as one
            sent = {f: new.get(f) for f in owned
                    if new.get(f) != old.get(f) and not (new.get(f) in _EMPTY and old.get(f) in _EMPTY)}
        plan.append([key, row, old, sent, None])
    if not any(step[3] for step in plan):
        return None
    key_field_, records = key_field(shape), _Records(source, shape)

    def outside_id(ref: Any, by: str) -> Any:
        return _outside_id(ref, by, owner, links)

    for step in plan:
        key, row, old, sent, _ = step
        if key and (expected or {}).get(key) not in (None, have.get(key, {}).get("version")):
            raise ConflictError(f"row {key!r} changed since version {expected[key]}")
        details = dataset.check_details({**({"key": key} if old is not None else {}), **row}, cache=checked, by=as_)
        if details:
            raise LinkError([{**d, "path": f"{key}.{d['path']}" if key and len(rows) > 1 else d["path"]} for d in details])
        if old is not None and sent:
            # A list of links the row could not resolve when it was mirrored (no row to link to yet)
            # is NOT the row's to shrink: writing the list as the row has it would drop those links
            # in the outside system. Refused before any I/O; mirror the linked rows first.
            dumped = await records.get(old.get(key_field_))
            lost = {name: _unlinked(shape, name, dumped, old.get(name), outside_id) for name in sent}
            lost = {name: ids for name, ids in lost.items() if ids}
            if lost:
                raise LinkError([{"path": f"input.{name}", "code": "unlinked",
                                  "message": f"{name} holds {len(ids)} link(s) no row here resolves ({', '.join(ids)}): "
                                             f"a write would drop them in {source.provider}; mirror those rows first"}
                                 for name, ids in lost.items()])
        step[4] = outside_changes(shape, sent, owner, links) if sent else None   # refused before any I/O
    sent_to, warned, answered = {}, {}, []
    try:
        for n, (key, row, old, sent, changes) in enumerate(plan):
            if changes is None:
                continue
            if old is None:
                done = await source.create(changes)
            else:
                item = await records.get(old.get(key_field_))
                if item is None:
                    raise _refused("source_refused", f"row {key!r} has no record in {source.provider} any more: pull the rows first")
                done = await source.update(str(item["external_id"]), changes)
            sent_to[n] = _key_of(done, shape)
            answered.append({k: v for k, v in done.items() if k != "warnings"})
            if done.get("warnings"):
                warned[n] = list(done["warnings"])
    except (PermissionError, NotImplementedError):
        if not sent_to:
            return None                                  # the source cannot write: the plain write says `owned`
        raise
    except LinkError:
        raise
    except Exception as exc:  # noqa: BLE001 -- whatever the outside system said, as one refusal
        raise _refused("source_refused", f"{source.provider} refused the change: {exc}") from exc
    # The records as the system answered the writes become their rows -- no whole re-read: the write
    # has happened, and a rate limit on a listing must not make it look as if it had not.
    await dataset.mirror(answered, shape, by=as_, prune=False)
    now = _rows_by(dataset, f"input.{key_field_}", list(sent_to.values()))
    out = []
    for n, (key, row, *_rest) in enumerate(plan):
        mirrored = now.get(sent_to.get(n)) if n in sent_to else None
        if mirrored is None and n in sent_to:
            # The outside system made or changed the record, and the mirror did not make a row that fits
            # from it (`rows().problems` has it): said as what it is, never "a key is required".
            raise _refused("misfit", f"{source.provider} has the record ({sent_to[n]}), but it does not fit the row kind: "
                                     f"see this dataset's problems and fix the schema or the record")
        if mirrored is None:
            out.append((key, row))
            continue
        mine = {f: v for f, v in (row.get("input") or {}).items() if f not in owned}
        out.append((mirrored["key"], {**row, "input": {**mirrored["input"], **mine}}))
    # each warning names its row by the key it is written under (a new row's is the record's)
    warnings = [{"error_code": SOURCE_PARTIAL, "message": f"{source.provider}: {said}", "key": out[n][0]}
                for n, saids in sorted(warned.items()) for said in saids]
    return out, as_, warnings


async def delete_through(dataset: Any, keys: list[str], expected: Optional[dict] = None) -> Optional[list[str]]:
    """Remove the records behind ``keys`` from the outside system, then the rows. None when no source
    the rows of ``dataset`` are files (the plain delete applies). Everything the plain delete refuses -- a key
    that is no row, a row changed since ``expected``, a row others still link to -- is refused before
    any I/O; a source that cannot delete refuses as ``owned``: the row would only come back with the
    next sync."""
    if not _owned(dataset):
        return None
    source = record_system(dataset)
    if source is None:
        return None
    shape = source.map
    with dataset._lock():
        dataset._check_delete(keys, expected or {})
    have = _rows_by(dataset, "key", keys)
    records, key_field_ = _Records(source, shape), key_field(shape)
    try:
        for key in keys:
            item = await records.get(have[key]["input"].get(key_field_)) if key in have else None
            if item is not None:
                await source.delete(str(item["external_id"]))
    except (PermissionError, NotImplementedError) as exc:
        raise _refused("owned", f"these rows are {source.provider}'s: {exc}") from exc
    except LookupError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise _refused("source_refused", f"{source.provider} refused the delete: {exc}") from exc
    return dataset.delete_rows(keys)
