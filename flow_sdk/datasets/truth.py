"""Field truth -- which fields of a row kind a SYSTEM OF RECORD holds.

A field of a record kind says where its value comes from when its dataset's data source is a system of
record (a CRM), in the data model (``data_schema.json``)::

    "name":    {"shape": "string", "truth": "soc.data.title"}      # the record's ``data.title``
    "stage":   {"shape": "string", "truth": "soc"}                  # the record's ``data.stage``
    "crm_id":  {"shape": "string", "truth": "soc.external_id"}      # the record's id: how a row finds it
    "icp":     {"shape": "gtm.icp", "truth": {"link": "gtm.icp", "by": "key", "path": "soc.data.gtm_icp"}}
    "notes":   {"shape": "?string"}                                  # no truth: ours, kept in the data store

``soc`` is the record as a flat envelope (``external_id``, ``permalink``, ``data.<field>``); ``"soc"`` alone
reads ``data.<the field's name>``. ``{"link", "by", "path"}`` makes the system's id at ``path`` a link to
the row of ``link`` whose ``by`` (a ``unique`` field, or ``key``) holds it; ``{"value": x}`` is a constant.
Exactly one field reads ``soc.external_id``: it joins a row to its record.

A dataset in any other source ignores truth: every field is its own.
"""

from __future__ import annotations

from typing import Any

PREFIX = "soc"
#: The record's own id in the envelope: the field that reads it joins a row to its record.
KEY_PATH = "external_id"


def _path(value: Any, name: str) -> str:
    if value == PREFIX:
        return f"data.{name}"
    if isinstance(value, str) and value.startswith(PREFIX + ".") and len(value) > len(PREFIX) + 1:
        return value[len(PREFIX) + 1:]
    raise ValueError(f'truth: "{PREFIX}" or "{PREFIX}.<path>" (soc.data.title, soc.external_id), not {value!r}')


def entry(name: str, value: Any) -> Any:
    """A field's ``truth`` as written → the path (or link, or constant) it reads from the record.
    ``ValueError`` naming what is wrong."""
    if isinstance(value, dict):
        if set(value) == {"value"}:
            return dict(value)
        if set(value) == {"link", "by", "path"} and all(isinstance(value[k], str) for k in value):
            return {"link": value["link"], "by": value["by"], "path": _path(value["path"], name)}
        raise ValueError('truth: {"link", "by", "path": "soc.<path>"} or {"value": x} is required')
    return _path(value, name)


def truth_of(shape: Any) -> dict:
    """``{field: entry}`` of a record kind's truth fields (its includes' among them)."""
    return dict(getattr(shape, "__truth__", None) or {})


def mirror_map(shape: Any) -> dict:
    """The map a system of record's records become rows by: ``{"key": "external_id", "input": {...}}`` from
    the kind's truth fields. ``ValueError`` when no field reads the record's id."""
    fields = truth_of(shape)
    if KEY_PATH not in fields.values():
        kind = getattr(shape, "spec_kind", "") or getattr(shape, "__name__", "the row kind")
        raise ValueError(f'{kind}: no field says "truth": "{PREFIX}.{KEY_PATH}" -- the field that joins a row to its record')
    return {"key": KEY_PATH, "input": fields}
