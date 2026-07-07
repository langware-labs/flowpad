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
