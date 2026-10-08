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


def dangling(value: Any, owner: Path | str, *, stores: tuple = (), cache: Optional[dict] = None) -> list[str]:
    """One error per reference in ``value`` that names nothing: no row of its kind in a dataset beside
    it, and -- for a kind no dataset there holds -- no value of it in ``stores`` (the value stores a
    reference may also point into, ``flow_sdk.values``). ``cache`` keeps the rows' ids across calls,
    so checking every row of a dataset reads each target dataset once."""
    from flow_sdk.schema.data_spec.spec import spec_tag  # noqa: PLC0415
    from flow_sdk.values import resolve_ref  # noqa: PLC0415

    errors, ids_of = [], cache if cache is not None else {}
    # A row kind (one a dataset beside holds) is LINKED, never copied in: an inline copy escapes the
    # link checks and the delete protection, and goes stale the moment the row changes.
    for where, nested in inline_values(value):
        tag = spec_tag(nested)
        if tag and tag not in ids_of:
            folders = datasets_for_kind(tag, owner)
            ids_of[tag] = {i for folder in folders for i in _row_ids(folder)} if folders else None
        if tag and ids_of.get(tag) is not None:
            errors.append(f"{where}: a {tag} row written inline -- link to the row instead (its ref, <kind>.id.<uuid>)")
    for where, ref in links_in(value):
        kind, rid = parse_ref(ref)  # type: ignore[misc]
        if kind not in ids_of:
            folders = datasets_for_kind(kind, owner)
            ids_of[kind] = {i for folder in folders for i in _row_ids(folder)} if folders else None
        if ids_of[kind] is not None:
            if rid not in ids_of[kind]:
                errors.append(f"{where}: no {kind} row {rid}")
            continue
        for store in stores:
            try:
                resolve_ref(ref, near=store)
                break
            except (LookupError, ValueError):
                continue
        else:
            errors.append(f"{where}: no {kind} row or stored value {rid}")
    return errors


SLOTS = ("input", "context", "output", "ground_truth")


def _mentions(raw: Any, ref: str) -> bool:
    """Whether a value read UNCHECKED holds ``ref`` anywhere -- no schema to say which strings are
    links, and a reference is unique enough that holding it is pointing at it."""
    if isinstance(raw, dict):
        return any(_mentions(v, ref) for v in raw.values())
    if isinstance(raw, list):
        return any(_mentions(v, ref) for v in raw)
    return raw == ref


def referrers(ref: str, owner: Path | str, *, rows_of: Any) -> list[str]:
    """Who points at ``ref``: ``"<kind> <key>"`` per row, across the datasets beside it.
    ``rows_of(folder)`` answers ``(typed rows, problems)`` (``Dataset.rows_and_problems``): a row's
    every slot is looked at, and a row that does not fit counts too -- by its input as stored --
    so a row broken today still protects what it points at."""
    root = Path(owner) / "agentic-assets" / DATASET_FAMILY
    found = []
    for folder in sorted(root.iterdir()) if root.is_dir() else []:
        if not (folder / MANIFEST).is_file():
            continue
        kind = row_kind(_manifest_spec(folder))
        rows, problems = rows_of(folder)
        for row in rows:
            held = [getattr(row, slot, None) for slot in SLOTS]
            values = [v for h in held for v in (h if isinstance(h, list) else [h])]
            if any(link == ref for value in values for _, link in links_in(value)):
                found.append(f"{kind} {row.key}")
        found += [f"{kind} {p['key']}" for p in problems if _mentions(p.get("input"), ref)]
    return found


def find_row(ref: str, owner: Path | str) -> Optional[tuple[Path, str]]:
    """``(dataset folder, key)`` of the row ``ref`` names, or None."""
    parsed = parse_ref(ref)
    if parsed is None:
        return None
    kind, rid = parsed
    for folder in datasets_for_kind(kind, owner):
        key = _row_ids(folder).get(rid)
        if key:
            return folder, key
    return None


__all__ = ["dangling", "datasets_for_kind", "find_row", "links_in", "owner_of", "referrers", "row_kind"]
