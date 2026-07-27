"""Backend-side read access to the per-instance preferences.json.

The preferences file is owned by the frontend prefMan (PREF_REGISTRY in
ts_sdk/src/preferences/prefRegistry.ts); keys are the dotted
``preferences.<category>.<name>`` PrefKey ids. The server seeds defaults and
does merge-writes in ``flow_sdk/server/routes/bootstrap.py`` (`_read_pref` /
`_write_pref` there predate this module and stay as-is); this module is the
import-light reader for backend components that must not import the routes
package (e.g. the indexer factory).
"""
from __future__ import annotations

import json
from typing import Any

PREF_SHARE_MESSAGE_STATUS = "preferences.notifications.share_message_status"
DEFAULT_SHARE_MESSAGE_STATUS = True


def read_instance_pref(key: str, default: Any) -> Any:
    """Read one dotted PrefKey from the instance preferences.json.

    Returns ``default`` when the file or key is missing or unreadable —
    never raises.
    """
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    path = get_instance_settings().instance_dir / "preferences.json"
    if not path.exists():
        return default
    try:
        prefs = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default
    if not isinstance(prefs, dict) or key not in prefs:
        return default
    return prefs[key]


def message_status_sharing_enabled() -> bool:
    """Whether this instance reports delivered/read status to other users."""
    return bool(read_instance_pref(PREF_SHARE_MESSAGE_STATUS, DEFAULT_SHARE_MESSAGE_STATUS))


def write_instance_pref(key: str, value: Any) -> bool:
    """Merge one dotted PrefKey into the instance preferences.json.

    Read-modify-write preserving every other key (the same merge contract the
    frontend store and ``bootstrap._write_pref`` use, so writers never clobber
    each other). Returns True on success, False on any I/O error — never raises.
    """
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    path = get_instance_settings().instance_dir / "preferences.json"
    prefs: dict = {}
    if path.exists():
        try:
            parsed = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(parsed, dict):
                prefs = parsed
        except (OSError, json.JSONDecodeError):
            prefs = {}
    prefs[key] = value
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(prefs, indent=2), encoding="utf-8")
        return True
    except OSError:
        return False
