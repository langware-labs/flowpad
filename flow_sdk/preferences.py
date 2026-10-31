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
#: SmartNavigationLog: append every smart-navigation decision to a dataset in Flowpad's temp folder.
PREF_SMART_NAVIGATION_LOG = "preferences.advanced.smart_navigation_log"
#: Secured transfer: this install publishes a device key so members can send it credential values (on unless turned off).
PREF_SECURE_RECEIVING = "preferences.sharing.secure_receiving"
DEFAULT_SECURE_RECEIVING = True
DEFAULT_SMART_NAVIGATION_LOG = False
#: The model size (sm/md/lg) a worker runs when nobody named one; the endpoint says which model that is.
PREF_LLM_DEFAULT_SIZE = "preferences.llm.default_size"
DEFAULT_LLM_SIZE = "md"
#: The order token sources are tried in when nothing pins one (``llm_source`` rung 4). Stored by the UI
#: as a comma-separated string (``"endpoint,device,api_key"``); a list is accepted too.
PREF_LLM_SOURCE_ORDER = "preferences.llm.source_order"
DEFAULT_LLM_SOURCE_ORDER = ("device", "api_key", "endpoint")


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


def read_instance_prefs(defaults: dict[str, Any]) -> dict[str, Any]:
    """Read several dotted PrefKeys in ONE file read.

    ``read_instance_pref`` re-stats, re-opens and re-parses ``preferences.json``
    per key, so reading a block of N keys costs N of each. Callers on a hot path
    (project activation reads four) should use this instead. Same never-raises
    contract: any unreadable file yields ``defaults`` verbatim.
    """
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    path = get_instance_settings().instance_dir / "preferences.json"
    try:
        prefs = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return dict(defaults)
    if not isinstance(prefs, dict):
        return dict(defaults)
    return {key: prefs.get(key, fallback) for key, fallback in defaults.items()}


def message_status_sharing_enabled() -> bool:
    """Whether this instance reports delivered/read status to other users."""
    return bool(read_instance_pref(PREF_SHARE_MESSAGE_STATUS, DEFAULT_SHARE_MESSAGE_STATUS))


def secure_receiving_enabled() -> bool:
    """Whether this install can receive credential values by secured transfer (its device key is published)."""
    return bool(read_instance_pref(PREF_SECURE_RECEIVING, DEFAULT_SECURE_RECEIVING))


def smart_navigation_log_enabled() -> bool:
    """Whether smart-navigation decisions are collected as dataset rows (off unless turned on)."""
    return bool(read_instance_pref(PREF_SMART_NAVIGATION_LOG, DEFAULT_SMART_NAVIGATION_LOG))


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


def llm_source_order() -> tuple[str, ...]:
    """The source kinds in the user's order (``preferences.llm.source_order``), every known kind once.

    Accepts the UI's comma-separated string or a list; unknown kinds are dropped and missing ones
    go last, so the answer always ranks every kind.
    """
    raw = read_instance_pref(PREF_LLM_SOURCE_ORDER, list(DEFAULT_LLM_SOURCE_ORDER))
    if isinstance(raw, str):
        raw = [part.strip() for part in raw.split(",")]
    kinds = [k for k in raw if k in DEFAULT_LLM_SOURCE_ORDER] if isinstance(raw, list) else []
    return tuple(dict.fromkeys([*kinds, *DEFAULT_LLM_SOURCE_ORDER]))
