"""Page state keys — what keeps a link from running a page in the local app.

The local server answers no ``/api/*`` call or WebSocket unless it carries a state key it minted
(``X-Flowpad-State`` header, ``state`` query, or — for a page's own sub-resources — the ``state`` in
its Referer). A key maps to a :class:`PageState`. Whoever opens a page on this machine (``flow show``,
an agent, the app shell after the user said Allow) mints one and hands it over; a link from outside
cannot, so what it points at has no key and the app asks the user first.

This is NOT the cookie gate. The gate keeps unauthorized users off the machine; this keeps a link
from making the user's own app run something. It is enforced only on a local install (no hub
assignment) and follows the gate's off switch, so dev runs and the test suite are untouched.

Held in memory and mirrored to ``<instance_dir>/page_states.json`` so open tabs survive a restart. A
key is a random string; nothing is signed and nothing is hashed — it only has to be unguessable.
"""

from __future__ import annotations

import logging
import os
import re
import secrets
import threading
from pathlib import Path
from typing import Optional

from starlette.requests import HTTPConnection

from flow_sdk.instance_settings import get_instance_settings
from flow_sdk.instances.atomic import read_json, write_json_atomic
from flow_sdk.schema.data_spec.page_state_spec import PageState

logger = logging.getLogger(__name__)

HEADER = "x-flowpad-state"
QUERY = "state"
#: What a key can look like — also what may be written into a page's source.
KEY_PATTERN = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
_FILENAME = "page_states.json"
#: Oldest keys are forgotten past this; an open tab refers to a recent one.
_MAX_STATES = 2000

_lock = threading.Lock()
_states: dict[str, PageState] = {}
_loaded_from: Optional[Path] = None


def enforced() -> bool:
    """Whether this process demands a key: a local install with the cookie gate on."""
    from flow_sdk.instance_settings.runtime import get_assigned_runtime  # noqa: PLC0415
    from flow_sdk.server.middleware.cookie_gate_middleware import OFF_SWITCH_ENV  # noqa: PLC0415

    return os.environ.get(OFF_SWITCH_ENV) != "off" and get_assigned_runtime() is None


def _path() -> Path:
    return get_instance_settings().instance_dir / _FILENAME


def _load() -> None:
    """Read the file once per instance dir (tests switch it); a missing or broken file is an empty store."""
    global _loaded_from
    path = _path()
    if _loaded_from == path:
        return
    _loaded_from = path
    _states.clear()
    for key, value in read_json(path).items():
        try:
            if KEY_PATTERN.match(key):
                _states[key] = PageState.model_validate(value)
        except ValueError as exc:
            logger.warning("page-state: dropping an unreadable entry from %s: %s", path, exc)


def _save() -> None:
    try:
        write_json_atomic(_path(), {k: v.model_dump(mode="json") for k, v in _states.items()})
    except OSError as exc:
        logger.warning("page-state: cannot write %s: %s", _path(), exc)


def mint(state: PageState) -> str:
    """A fresh key for *state*."""
    key = secrets.token_urlsafe(24)
    with _lock:
        _load()
        _states[key] = state
        while len(_states) > _MAX_STATES:
            del _states[next(k for k, v in _states.items() if v.grant != "app")]  # the oldest page key
        _save()
    return key


def app_key() -> str:
    """The app shell's key — one for this instance, so a reload mints nothing and no page churn can evict it."""
    with _lock:
        _load()
        held = next((k for k, v in _states.items() if v.grant == "app"), None)
    return held or mint(PageState(grant="app", title="Flowpad"))


def lookup(key: Optional[str]) -> Optional[PageState]:
    if not key or not KEY_PATTERN.match(key):
        return None
    with _lock:
        _load()
        return _states.get(key)


def reset_for_tests() -> None:
    global _loaded_from
    with _lock:
        _states.clear()
        _loaded_from = None


def presented_key(conn: HTTPConnection) -> Optional[str]:
    """The key a request carries: the header, the query, or — for a same-origin GET (a page's own
    images, scripts, relative pages) — the ``state`` in the page's URL that the browser sent as Referer."""
    key = conn.headers.get(HEADER) or conn.query_params.get(QUERY)
    if key:
        return key
    if conn.scope.get("method") in ("GET", "HEAD") and conn.headers.get("sec-fetch-site") == "same-origin":
        from urllib.parse import parse_qs, urlsplit  # noqa: PLC0415

        referer = conn.headers.get("referer")
        if referer:
            return (parse_qs(urlsplit(referer).query).get(QUERY) or [None])[0]
    return None


def key_of(conn: HTTPConnection) -> Optional[str]:
    """The key the state-key middleware accepted for this request, if it ran and found one."""
    return (conn.scope.get("state") or {}).get("page_state_key")


def state_of(conn: HTTPConnection) -> Optional[PageState]:
    return (conn.scope.get("state") or {}).get("page_state")


__all__ = ["HEADER", "KEY_PATTERN", "QUERY", "app_key", "enforced", "key_of", "lookup", "mint", "presented_key", "state_of"]
