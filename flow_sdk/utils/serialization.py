import json
from datetime import datetime

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
    return datetime.fromisoformat(iso)


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
