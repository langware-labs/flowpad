import json
from datetime import datetime, timezone

import dpath
from fastapi.encoders import jsonable_encoder


def type_safe_json(jsonable_object, **kwargs):
    exclude_none = kwargs.pop("exclude_none", True)
    return jsonable_encoder(jsonable_object, exclude_none=exclude_none, **kwargs)


def type_safe_json_dumps(jsonable_object, indent=0, **kwargs):
    return json.dumps(type_safe_json(jsonable_object, **kwargs), indent=indent)


def iso_to_datetime(iso: datetime | str) -> datetime:
    if isinstance(iso, datetime):
        return iso
    # Python 3.10 doesn't support the 'Z' UTC suffix in fromisoformat
    if isinstance(iso, str) and iso.endswith("Z"):
        iso = iso[:-1] + "+00:00"
    return datetime.fromisoformat(iso)


def iso_to_utc(iso: datetime | str | None) -> datetime | None:
    """``iso`` as an aware UTC datetime, or None when it is absent/unparseable.

    The forgiving twin of :func:`iso_to_datetime`, for the many callers that
    hold an optional timestamp of unknown provenance and want a comparable value
    or nothing. Both halves are the part that kept getting rewritten: tolerating
    a ``Z`` suffix (3.10's ``fromisoformat`` rejects it), and reading a NAIVE
    timestamp as UTC rather than local — which is what every stored timestamp in
    this repo means.
    """
    if iso is None or iso == "":
        return None
    try:
        parsed = iso_to_datetime(iso)
    except (ValueError, TypeError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def now_epoch_ms() -> int:
    """Current UTC time in epoch-milliseconds (the ``last_active_at`` wire format)."""
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def starlett_query_brackets_to_dict(bracket_dict):
    """
    axios send bracket notation in get param, stalert knows how to parse it paritally
    Convert a flat dictionary to a nested dictionary.
    The keys are assumed to be with square brackets separating nested levels.
    For example, the key "a[b][c]" will be converted to {"a": {"b": {"c": value}}}.
    Also supports list indices in the key.
    For example, "a[0][1]" will be converted to {"a": [[None, value]]}.
    """
    nested_dict = {}
    for key, value in bracket_dict.items():
        keys = key.replace("]", "").replace("[", "/").strip("/").split("/")
        dpath.new(nested_dict, keys, value)
    return nested_dict
