"""The hash of what a rule DOES — the anchor of "Not tested yet".

``updated_date`` cannot answer "was this rule tested since it last changed":
every fire bumps it (the counter is written back) and so does every boot
re-index. A rule's behaviour is its trigger condition plus its actions; hash
exactly those, and a test row carrying the same hash proves the rule as it is
now was exercised.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

#: The fields that decide WHEN a rule fires and WHAT it does. Not ``enabled``
#: (switching off and on is not an edit), not ``name``/``description``, not
#: runtime state (counter, last_run, next_run).
BEHAVIOUR_FIELDS: tuple[str, ...] = (
    "trigger_type",
    "expr", "sched_trigger_type", "timezone",
    "watch_path", "recursive", "watch_glob", "ignore_patterns", "respect_gitignore",
    "tag_pattern", "tag_target", "tag_scope", "confirm", "fire_once",
    "mask", "hook_events",
    "instruction", "workdir",
    "gate", "then",
)


def _plain(value: Any) -> Any:
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        return dump(mode="json", exclude_none=True)
    if isinstance(value, list):
        return [_plain(v) for v in value]
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    return value


def spec_hash(trigger: Any) -> str:
    """Stable 16-hex hash of a trigger's behaviour. Same rule → same hash."""
    shape = {field: _plain(getattr(trigger, field, None)) for field in BEHAVIOUR_FIELDS}
    shape["actions"] = _plain(list(getattr(trigger, "actions", None) or []))
    text = json.dumps(shape, sort_keys=True, default=str)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
