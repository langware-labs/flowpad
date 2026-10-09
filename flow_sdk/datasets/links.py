"""Links between dataset rows: a row points at another with ``<kind>.id.<uuid>`` (``value_ref``).

A field typed by a kind holds a value of it or a REFERENCE to one stored instance; a dataset row is
such an instance -- its kind is the dataset's row kind, its id the one the row stores
(``layout.row_id``). This module answers the questions a write needs answered:

* which datasets hold rows of a kind, next to a given one (``datasets_for_kind``) -- a one-level look
  at ``<owner>/agentic-assets/dataset/*/dataset.json``, so it works in a script as in the server;
* which references a value carries, and where (``links_in``);
* whether each one names a row that exists (``dangling``), and who still points at a row
  (``referrers``).

A reference whose kind no dataset there holds is not this module's to judge (a value kept in a value
store, ``flow_sdk.values``, is one too): only rows are checked.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterator, Optional

from flow_sdk.schema.data_spec.value_ref import parse_ref

DATASET_FAMILY = "dataset"
MANIFEST = "dataset.json"


def owner_of(dataset_folder: Path | str) -> Path:
    """The folder whose ``agentic-assets/dataset/`` holds this dataset (its project, usually)."""
    return Path(dataset_folder).parent.parent.parent


def row_kind(spec: Any) -> str:
    """The kind a dataset's rows are, from its ``spec``: a named dataset kind's ``input``, or the
    inline form's ``input`` as written (full name). ``""`` when it names no kind."""
    if isinstance(spec, str):
        from flow_sdk.schema.data_spec.dataset_spec import DatasetSpec  # noqa: PLC0415
        from flow_sdk.schema.data_spec.spec import spec_tag  # noqa: PLC0415

        try:
            shape = DatasetSpec.parse(spec).example_type().input_type()
        except ValueError:
            return ""
        return spec_tag(shape) if isinstance(shape, type) else ""
    if isinstance(spec, dict):
        examples = spec.get("examples")
        first = examples[0] if isinstance(examples, list) and examples else examples
        if isinstance(first, dict) and isinstance(first.get("input"), str):
            return first["input"].lstrip("?")
    return ""


def _manifest_spec(folder: Path) -> Any:
    try:
        doc = json.loads((folder / MANIFEST).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return ((doc.get("metadata") or {}) if isinstance(doc, dict) else {}).get("spec")


def datasets_for_kind(kind: str, owner: Path | str) -> list[Path]:
    """The dataset folders under ``<owner>/agentic-assets/dataset/`` whose rows are ``kind``."""
    root = Path(owner) / "agentic-assets" / DATASET_FAMILY
    if not root.is_dir():
        return []
    return [folder for folder in sorted(root.iterdir())
            if (folder / MANIFEST).is_file() and row_kind(_manifest_spec(folder)) == kind]


def _forms(value: Any) -> dict:
    forms = getattr(type(value), "__authoring__", None)
    return forms if isinstance(forms, dict) else {}


def links_in(value: Any, path: str = "") -> Iterator[tuple[str, str]]:
    """``(where, reference)`` for every reference a value carries -- read off the schema it was
    authored with, so a string that merely looks like one in a text field is never mistaken for it."""
    from flow_sdk.schema.data_spec.spec import DataSpec  # noqa: PLC0415

    if not isinstance(value, DataSpec):
        return
    for name, form in _forms(value).items():
        held = getattr(value, name, None)
        where = f"{path}{name}"
        items = held if isinstance(held, list) else [held]
        for index, item in enumerate(items):
            at = f"{where}.{index}" if isinstance(held, list) else where
            if isinstance(item, str) and parse_ref(item) is not None and not _is_scalar_form(form):
                yield at, item
            elif isinstance(item, DataSpec):
                yield from links_in(item, f"{at}.")


def inline_values(value: Any, path: str = "") -> Iterator[tuple[str, Any]]:
    """``(where, nested value)`` for every value of a kind nested in ``value`` -- the candidates for
    "a row written inline where a link belongs"."""
    from flow_sdk.schema.data_spec.spec import DataSpec  # noqa: PLC0415

    if not isinstance(value, DataSpec):
        return
    for name in _forms(value):
        held = getattr(value, name, None)
        items = held if isinstance(held, list) else [held]
        for index, item in enumerate(items):
            at = f"{path}{name}.{index}" if isinstance(held, list) else f"{path}{name}"
            if isinstance(item, DataSpec):
                yield at, item
                yield from inline_values(item, f"{at}.")


def _is_scalar_form(form: Any) -> bool:
    """A primitive or an enum -- a form whose strings are never references."""
    from flow_sdk.schema.data_spec._kinds import PRIMITIVES  # noqa: PLC0415
    from flow_sdk.schema.data_spec.spec import ENUM_PREFIX  # noqa: PLC0415

    form = form[0] if isinstance(form, list) and form else form
    if not isinstance(form, str):
        return False
    bare = form.lstrip("?")
    return bare.startswith(ENUM_PREFIX) or bare in PRIMITIVES


def _row_ids(dataset_folder: Path) -> dict[str, str]:
    """``{row id: key}`` for one dataset, reading only each row's ``example.json``."""
    from flow_sdk.schema.data_spec.io.identity import FolderCapsule  # noqa: PLC0415
    from flow_sdk.schema.data_spec.layout import _example_dirs, row_id  # noqa: PLC0415

    dataset_id = FolderCapsule().read(dataset_folder) or ""
    return {row_id(ex_dir, dataset_id): ex_dir.name for ex_dir in _example_dirs(dataset_folder)}


def _row_index(kind: str, owner: Path | str, cache: dict) -> Optional[dict[str, tuple[Path, str]]]:
    """``{row id: (dataset folder, key)}`` for the rows of ``kind`` beside ``owner`` -- read once per
    ``cache`` (the link checks, the rule walks and ``find_row`` share it). None when no dataset there
    holds ``kind``."""
    slot = ("rows-of-kind", kind)
    if slot not in cache:
        folders = datasets_for_kind(kind, owner)
        cache[slot] = {rid: (folder, key) for folder in folders for rid, key in _row_ids(folder).items()} if folders else None
    return cache[slot]


def _inline_detail(where: str, tag: str, owner: Path | str, cache: dict) -> Optional[dict]:
    # A row kind (one a dataset beside holds) is LINKED, never copied in: an inline copy escapes the
    # link checks and the delete protection, and goes stale the moment the row changes.
    if tag and _row_index(tag, owner, cache) is not None:
        return {"path": where, "code": "inline_row",
                "message": f"a {tag} row written inline -- link to the row instead (its ref, <kind>.id.<uuid>)"}
    return None


def _ref_detail(where: str, ref: str, owner: Path | str, stores: tuple, cache: dict) -> Optional[dict]:
    from flow_sdk.values import resolve_ref  # noqa: PLC0415

    kind, rid = parse_ref(ref)  # type: ignore[misc]
    rows = _row_index(kind, owner, cache)
    if rows is not None:
        return None if rid in rows else {"path": where, "code": "dangling_ref", "message": f"no {kind} row {rid}"}
    for store in stores:
        try:
            resolve_ref(ref, near=store)
            return None
        except (LookupError, ValueError):
            continue
    return {"path": where, "code": "dangling_ref", "message": f"no {kind} row or stored value {rid}"}


def dangling_details(value: Any, owner: Path | str, *, stores: tuple = (), cache: Optional[dict] = None) -> list[dict]:
    """``[{path, code, message}]`` per reference in ``value`` that names nothing (``dangling_ref``: no
    row of its kind in a dataset beside it, and -- for a kind no dataset there holds -- no value of it
    in ``stores``, the value stores a reference may also point into) and per row kind copied in
    (``inline_row``). ``cache`` keeps the rows' ids across calls, so checking every row of a dataset
    reads each target dataset once."""
    from flow_sdk.schema.data_spec.spec import spec_tag  # noqa: PLC0415

    cache = cache if cache is not None else {}
    out = [_inline_detail(where, spec_tag(nested), owner, cache) for where, nested in inline_values(value)]
    out += [_ref_detail(where, ref, owner, stores, cache) for where, ref in links_in(value)]
    return [d for d in out if d]


def refs_in_raw(raw: Any, path: str = "") -> Iterator[tuple[str, str]]:
    """``(where, reference)`` for every string in a value read UNCHECKED that is a reference -- no
    schema to say which strings are links, and a reference is unique enough that holding one is
    pointing at it."""
    if isinstance(raw, dict):
        for name, held in raw.items():
            yield from refs_in_raw(held, f"{path}{name}.")
    elif isinstance(raw, list):
        for index, held in enumerate(raw):
            yield from refs_in_raw(held, f"{path}{index}.")
    elif isinstance(raw, str) and parse_ref(raw) is not None:
        yield path.rstrip("."), raw


def raw_dangling_details(raw: Any, owner: Path | str, *, stores: tuple = (), cache: Optional[dict] = None,
                         path: str = "") -> list[dict]:
    """The reference check on a value that does NOT fit its shape yet -- so a write refused for its
    shape reports its broken links in the same answer, not one round later. (Copied-in row kinds and
    rules need a value that fits: they come once it does.)"""
    cache = cache if cache is not None else {}
    found = [_ref_detail(where, ref, owner, stores, cache) for where, ref in refs_in_raw(raw, path)]
    return [d for d in found if d]


SLOTS = ("input", "context", "output", "ground_truth")


def slot_values(row: Any) -> Iterator[tuple[str, Any]]:
    """``(slot, value)`` for every value a row holds -- a slot holding several gives each."""
    for slot in SLOTS:
        held = getattr(row, slot, None)
        for value in held if isinstance(held, list) else [held]:
            if value is not None:
                yield slot, value


def link_index(owner: Path | str, *, read: Any) -> dict[str, list[tuple[Path, str, str, Any]]]:
    """``{reference: [(dataset folder, row kind, key, row or None)]}`` -- who points at whom, across
    the datasets beside ``owner``, read ONCE. ``read(folder)`` answers ``(typed rows, broken)`` with
    ``broken`` as ``(key, input as stored)`` (``Dataset.read_lenient``): a row's every slot counts,
    and a row that does not fit counts by its stored input (its row is None) -- so a row broken today
    still protects what it points at."""
    root, index = Path(owner) / "agentic-assets" / DATASET_FAMILY, {}
    for folder in sorted(root.iterdir()) if root.is_dir() else []:
        if not (folder / MANIFEST).is_file():
            continue
        kind = row_kind(_manifest_spec(folder))
        rows, broken = read(folder)
        for row in rows:
            for ref in {link for _, value in slot_values(row) for _, link in links_in(value)}:
                index.setdefault(ref, []).append((folder, kind, row.key, row))
        for key, raw in broken:
            for ref in {link for _, link in refs_in_raw(raw)}:
                index.setdefault(ref, []).append((folder, kind, key, None))
    return index


def referrers(ref: str, owner: Path | str, *, read: Any) -> list[str]:
    """Who points at ``ref``: ``"<kind> <key>"`` per row, across the datasets beside it (``link_index``)."""
    return [f"{kind} {key}" for _, kind, key, _ in link_index(owner, read=read).get(ref, [])]


def find_row(ref: str, owner: Path | str, *, cache: Optional[dict] = None) -> Optional[tuple[Path, str]]:
    """``(dataset folder, key)`` of the row ``ref`` names, or None."""
    parsed = parse_ref(ref)
    if parsed is None:
        return None
    rows = _row_index(parsed[0], owner, cache if cache is not None else {})
    return (rows or {}).get(parsed[1])


def shape_details(exc: Any) -> list[dict]:
    """A pydantic ``ValidationError`` as ``[{path, code: "shape:<type>", message}]``."""
    return [{"path": ".".join(str(p) for p in e.get("loc", ())), "code": f"shape:{e.get('type')}", "message": e.get("msg")}
            for e in exc.errors(include_url=False)]


def detail_lines(details: list[dict]) -> list[str]:
    """Details as the lines ``errors`` carries: ``"<path>: <message>"`` (the message alone at the top)."""
    return [f"{d['path']}: {d['message']}" if d.get("path") else d["message"] for d in details]


__all__ = ["SLOTS", "dangling_details", "datasets_for_kind", "detail_lines", "find_row", "link_index", "links_in",
           "owner_of", "raw_dangling_details", "referrers", "refs_in_raw", "row_kind", "shape_details", "slot_values"]
