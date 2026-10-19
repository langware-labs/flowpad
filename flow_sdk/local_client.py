"""Talk to the running Flowpad from a process that is not it -- a sync script, a worker, a test.

    from flow_sdk import local_client

    items = local_client.graph_get("source_item", {"match": {"data_source_id": sid}, "limit": 50})
    recent = local_client.graph_post(f"data_source/{sid}/items", {"limit": 20})["items"]

The instance is the one ``FLOW_INSTANCE`` names (a worker and a trigger's script have it pinned), on
the port its ``server.json`` records, through the same gate-safe transport the ``flow`` CLI uses.
This is how a script reads RECORDS (source items, sessions, tasks: what the instance's store keeps);
dataset ROWS it reads straight from disk (``Dataset.at`` / ``Dataset.for_kind``).

Every call answers the envelope's ``data``, or raises: ``NotRunning`` when no instance is up,
``LocalError`` (with the server's ``status``, message and ``data``) when it refuses.
"""

from __future__ import annotations

import json
from typing import Any, Optional


class NotRunning(RuntimeError):
    """No Flowpad instance is running for this ``FLOW_INSTANCE``."""


class LocalError(RuntimeError):
    """The instance refused the call: ``status``, its message, and the answer's ``data`` (a 400's reasons)."""

    def __init__(self, status: int, message: str, data: Any = None):
        super().__init__(f"HTTP {status}: {message}")
        self.status, self.data = status, data


def base_url() -> str:
    """``http://127.0.0.1:<port>/api/v1`` of the running instance -- ``NotRunning`` when there is none."""
    from flow_sdk.cli.commands._common import discover_port  # noqa: PLC0415

    port = discover_port(required=False)
    if port is None:
        raise NotRunning("no Flowpad instance is running (FLOW_INSTANCE names the one to reach)")
    return f"http://127.0.0.1:{port}/api/v1"


def request(method: str, path: str, *, params: Optional[dict] = None, body: Any = None, timeout: float = 60) -> Any:
    """One call to ``/api/v1/<path>``; the envelope's ``data``. A parameter that is not text travels as JSON."""
    from flow_sdk.cli.commands._common import local_request  # noqa: PLC0415

    query = {name: value if isinstance(value, str) else json.dumps(value)
             for name, value in (params or {}).items() if value is not None}
    resp = local_request(method, f"{base_url()}/{path.lstrip('/')}", params=query or None,
                         json=body if method.upper() != "GET" else None, timeout=timeout)
    try:
        envelope = resp.json() or {}
    except ValueError:
        raise LocalError(resp.status_code, (resp.text or "")[:200] or "not a JSON answer") from None
    if resp.status_code >= 400 or str(envelope.get("status", "")).lower() == "fail":
        raise LocalError(resp.status_code, envelope.get("message") or resp.reason or "refused", envelope.get("data"))
    return envelope.get("data")


def graph_get(path: str, filter: Optional[dict] = None, **params: Any) -> Any:   # noqa: A002 -- the parameter's own name
    """``GET /graph/<path>`` -- records of a type (``"source_item"``), one record (``"task/<id>"``) or
    a record's read action (``"dataset/<id>/rows"``). ``filter`` is ``{match, order_by, limit, offset}``."""
    return request("GET", f"graph/{path.lstrip('/')}", params={"filter": filter, **params})


def graph_post(path: str, body: Optional[dict] = None, *, timeout: float = 60) -> Any:
    """``POST /graph/<path>`` -- a record's action (``"data_source/<id>/items"``), or a create."""
    return request("POST", f"graph/{path.lstrip('/')}", body=body or {}, timeout=timeout)


def search(q: str, **params: Any) -> dict:
    """Record search (the full-text index ``flow record search`` reads): ``{results, total, ...}``."""
    return request("GET", "search", params={"q": q, **params}) or {}


__all__ = ["LocalError", "NotRunning", "base_url", "graph_get", "graph_post", "request", "search"]
