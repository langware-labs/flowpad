"""Field-rename compatibility for persisted rows.

A renamed persisted field leaves rows behind that still spell it the old way.
Each entity used to carry its own ``mode="before"`` validator for that, and the
third copy was byte-identical to the second — including a docstring naming the
wrong entity. One factory instead: the rename map is the only thing that
differs, so it is the only thing a caller writes.
"""
from __future__ import annotations


def adopt_renamed(data, renamed: dict[str, str]):
    """Move legacy keys onto their current names, in a ``mode="before"`` payload.

    A legacy value is adopted only when the current name has nothing — a row
    carrying both spellings is one the new writer already owns, and its value
    wins.
    """
    if not isinstance(data, dict):
        return data
    if not any(key in data for key in renamed):
        return data
    data = dict(data)
    for old_key, new_key in renamed.items():
        value = data.pop(old_key, None)
        if value is not None and not data.get(new_key):
            data[new_key] = value
    return data
