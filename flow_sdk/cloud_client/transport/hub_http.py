"""Hub connection plumbing: base URL, graph URL building, the shared hooked client.

Every hub request is sent by ``flow_sdk.cloud_client.hub_proxy.HubProxy``; this module
owns what it is sent WITH — the process-shared ``FlowpadClient`` (one TLS context, one
pool, bearer + machine id injected by its hooks), the hub's base URL (``None`` in Local
privacy mode), and the graph URL grammar.

URL structure follows the Flowpad Hub API guidelines:
  /api/v1/graph/[{scope_type}/{scope_id}/...]{entity_type}[/{entity_id}][/{action}]
"""

from __future__ import annotations

import asyncio
import contextlib as _contextlib
import logging
from contextvars import ContextVar
from typing import Any, Optional

import httpx

from flow_sdk.cloud_client.client import ApiConfig, FlowpadClient
from flow_sdk.cloud_client.shared.errors import HubError, classify_hub_failure  # noqa: F401 — HubError is re-exported
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.schema.data_spec.hub_failure_spec import HubFailureKind

logger = logging.getLogger(__name__)


# Process-shared hub client. Every hub call used to do
# ``async with FlowpadClient(ApiConfig.from_env())`` — a fresh client (and thus
# a fresh httpx client + a freshly-built TLS context) per call. Building that
# context reloads the CA bundle from disk (``ssl.load_verify_locations``), which
# profiling showed was ~40% of a conversation-list request (219 hub calls → 219
# cert-bundle loads). Reusing ONE client builds the TLS context once and pools
# connections; httpx clients are safe for concurrent use, and per-request auth
# is injected by the client's event hooks, so the shared instance needs no
# per-call credential refresh. Rebuilt when the hub base URL changes (read back
# off the client itself) or when the running loop is not the one it was built on.
_shared_client: "FlowpadClient | None" = None
_shared_client_loop: "asyncio.AbstractEventLoop | None" = None


#: Whether the last hub call could not reach the hub (nothing answered, or it answered 5xx/408/425/429).
#: The first call that reaches it afterwards drains the outbox once: it is the one moment the hub is
#: known to be back that no other transition sees -- an HTTP failure while the WebSocket stayed up.
_hub_unreachable = False
#: Set while the outbox drains, so a drain never sets off another (a message that keeps failing beside
#: one that succeeds would otherwise drain in a loop).
outbox_draining: ContextVar[bool] = ContextVar("outbox_draining", default=False)


def _note_reach(status_code: int) -> None:
    """Record whether this call reached the hub; on the edge back, drain the outbox."""
    global _hub_unreachable
    if status_code == 0 or classify_hub_failure(status_code) is HubFailureKind.SERVER_ERROR:
        _hub_unreachable = True
    elif _hub_unreachable and not outbox_draining.get():
        _hub_unreachable = False
        from flow_sdk.stream_inbox.catchup import start_outbox_drain  # noqa: PLC0415 — catchup imports this module

        start_outbox_drain("hub reachable again")


@_contextlib.asynccontextmanager
async def _hub_client():
    """Yield the process-shared hub client. Does NOT close it on exit (the whole
    point is to keep the TLS context + connection pool alive across calls)."""
    global _shared_client, _shared_client_loop
    cfg = ApiConfig.from_env()
    loop = asyncio.get_running_loop()
    other_loop = _shared_client_loop is not loop
    if _shared_client is None or other_loop or _shared_client.config.api_base_url != cfg.api_base_url:
        if other_loop:
            # Built on another event loop (each ``asyncio.run``, each pytest test):
            # its pool is bound to that loop, and every call would fail with "bound
            # to a different event loop" — which ``try_call`` swallows as "hub
            # unreachable". It cannot be closed from here (its loop may be gone);
            # drop it. A detached task that outlives a ``close_hub_client()`` on a
            # dying loop rebuilds the client THERE, so a close alone never covers this.
            _shared_client = None
        else:
            await close_hub_client()  # close any stale (URL-changed) client first
        _shared_client = FlowpadClient(cfg)
        _shared_client_loop = loop
    yield _shared_client


async def close_hub_client() -> None:
    """Close the shared hub client (call on server shutdown)."""
    global _shared_client
    if _shared_client is not None:
        client, _shared_client = _shared_client, None
        try:
            await client.close()
        except Exception:  # noqa: BLE001
            pass


def rows_of(payload: Any) -> list[dict]:
    """The rows in a hub list answer: a bare list, or a dict wrapping one under
    ``data`` / ``items`` / ``results``. Non-dict rows are dropped."""
    if isinstance(payload, list):
        rows = payload
    elif isinstance(payload, dict):
        rows = next((v for k in ("data", "items", "results") if isinstance((v := payload.get(k)), list)), [])
    else:
        rows = []
    return [r for r in rows if isinstance(r, dict)]


def hub_base_url() -> Optional[str]:
    """Return the hub base URL from config, or None if not configured.

    In Local (private) data-privacy mode this always returns ``None`` so every
    outbound hub call short-circuits exactly as it does when ``FLOWPAD_HUB_URL``
    is unset — the single chokepoint that guarantees no HTTP reaches the cloud.
    """
    from flow_sdk.instance_settings.privacy_mode import is_local_mode

    if is_local_mode():
        return None
    from flow_sdk.config import default_service_config

    url = default_service_config.flowpad_hub_url
    return url.rstrip("/") if url else None


def hub_public_url(sub_path: str) -> Optional[str]:
    """Full hub URL for a PUBLIC (non-graph, unauthenticated) API route — e.g.
    ``health/version`` or ``diagnosis-report`` — or None if the hub isn't
    configured. The non-graph sibling of ``hub_graph_url``: "public" marks that it
    targets routes outside ``/graph`` that need no bearer (callable signed-out)."""
    base = hub_base_url()
    if not base:
        return None
    from flow_sdk.api.api_request import APIRequest

    return f"{base}{APIRequest.api_prefix}/{sub_path.lstrip('/')}"


async def get_info() -> Optional[dict[str, Any]]:
    """Fetch lightweight info about the configured hub.

    Currently returns the hub's running version and optional build metadata::

        {"version": "0.29.41", "deployed_at": "...", "generated_at": "..."}

    Hits the public ``GET /api/v1/health/version`` endpoint (no auth), so it
    works even when the user is signed out. Returns ``None`` when the hub is
    not configured (``FLOWPAD_HUB_URL`` unset) or unreachable.
    """
    url = hub_public_url("health/version")
    if not url:
        return None
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(url, timeout=httpx.Timeout(8))
            if resp.status_code != 200:
                logger.warning("[hub] GET %s returned %s", url, resp.status_code)
                return None
            # The hub wraps responses in an ApiResponse envelope. Older hubs
            # returned the version string directly; newer hubs return an object
            # with build timestamps.
            data = resp.json().get("data")
            if isinstance(data, str):
                return {"version": data}
            if isinstance(data, dict):
                version = data.get("version")
                deployed_at = data.get("deployed_at")
                generated_at = data.get("generated_at")
                # Default helpdesk project id — the app opens support tickets
                # against this project when no nearer desk is configured.
                # Returned by newer hubs only.
                helpdesk_project_id = data.get("helpdesk_project_id")
                # Portal repo for that desk (help content cloned locally).
                helpdesk_portal_git_url = data.get("helpdesk_portal_git_url")
                return {
                    "version": version if isinstance(version, str) else None,
                    "deployed_at": deployed_at if isinstance(deployed_at, str) else None,
                    "generated_at": generated_at if isinstance(generated_at, str) else None,
                    "helpdesk_project_id": (helpdesk_project_id if isinstance(helpdesk_project_id, str) else None),
                    "helpdesk_portal_git_url": (
                        helpdesk_portal_git_url if isinstance(helpdesk_portal_git_url, str) else None
                    ),
                    # What the hub promises beyond its shape (``idempotent_guest_conversation``);
                    # empty on a hub older than the field — which is exactly the answer for it.
                    "capabilities": [c for c in (data.get("capabilities") or []) if isinstance(c, str)],
                }
            return {"version": None}
    except Exception as e:  # noqa: BLE001
        logger.warning("[hub] get_info error (non-fatal): %s", e)
        return None


def hub_graph_url(
    entity_type: BuiltinEntityType | str,
    entity_id: str | None = None,
    action: str | None = None,
    sub_path: str | None = None,
    *,
    scope: list[tuple[str, str]] | None = None,
) -> Optional[str]:
    """Build a full hub graph URL per API guidelines, or None if hub is not configured.

    URL pattern:
      /api/v1/graph/[{scope_type}/{scope_id}/...]{entity_type}[/{entity_id}][/{action}[/{sub_path}]]

    Examples:
      hub_graph_url("notification")
        → ".../api/v1/graph/notification"                           (list / create)
      hub_graph_url("notification", "notif-123")
        → ".../api/v1/graph/notification/notif-123"                 (get / update / delete)
      hub_graph_url("notification", "notif-123", "open")
        → ".../api/v1/graph/notification/notif-123/open"            (action on entity)
      hub_graph_url("workspace", "ws-123", "fs", "download/report.pdf")
        → ".../api/v1/graph/workspace/ws-123/fs/download/report.pdf" (fs action with sub_path)
      hub_graph_url("page", "pg-456", scope=[("workspace", "ws-123")])
        → ".../api/v1/graph/workspace/ws-123/page/pg-456"           (scoped entity)
    """
    # A plain string is a TYPELESS hub action (``machine-enroll``): the hub's graph
    # router matches those the same way, and the desktop has no entity to name.
    from flow_sdk.core.urls.service_urls import hub_wire_type  # noqa: PLC0415

    entity_type_str = hub_wire_type(getattr(entity_type, "value", entity_type))
    if sub_path and not action:
        raise ValueError(
            f"sub_path '{sub_path}' requires an action "
            f"(URL pattern: {{entity_type}}/{{entity_id}}/{{action}}/{{sub_path}})"
        )
    base = hub_base_url()
    if not base:
        return None
    from flow_sdk.api.api_request import APIRequest

    segments: list[str] = []
    if scope:
        for scope_type, scope_id in scope:
            segments.extend([scope_type, scope_id])
    segments.append(entity_type_str)
    if entity_id:
        segments.append(entity_id)
    if action:
        segments.append(action)
    if sub_path:
        segments.append(sub_path.lstrip("/"))
    full_path = f"{APIRequest.api_prefix}{APIRequest.graph_prefix}/{'/'.join(segments)}"
    return f"{base}{full_path}"
