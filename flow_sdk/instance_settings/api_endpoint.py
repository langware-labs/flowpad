"""Hub ``APIEndpoint``s this box's user may call -- listed the way LLM endpoints are.

``fetch_hub_llm_endpoints`` (``instance_settings/llm_endpoint.py``) is the model and every
rule here is its rule, for the same reason:

* TWO reads, unioned. The type listing is access-scoped (rows the user holds a role on); an
  endpoint opened to every signed-in user carries no role edge, only an
  ``authenticated_role`` stamp, so it is in the ``catalog`` alone. A shared Jev endpoint is
  exactly that case.
* ``[]`` when signed out, without asking (an idle box must not collect 401 toasts).
* A 30-second memo; ``cached_only`` answers from it and never calls out; a failed refresh
  keeps the last good list rather than emptying it.
* Through ``hub_get``: the one chokepoint that honours Local privacy mode.

Finding a DECISION endpoint is then a filter on ``kinds``, not a hub query: the hub stores
the tag, the caller keeps the kinds it needs.
"""

from __future__ import annotations

import logging
import time
from urllib.parse import urlparse

from flow_sdk.instance_settings import get_instance_settings
from flow_sdk.schema.data_spec.api_endpoint_spec import APIEndpointOffer

logger = logging.getLogger(__name__)

DECISION_KIND = "decision"
_LIST_TTL_SECONDS = 30.0
#: instance name -> (fetched_at, offers)
_list_cache: dict[str, tuple[float, list[APIEndpointOffer]]] = {}


def invalidate_api_endpoint_listing() -> None:
    _list_cache.pop(get_instance_settings().instance_name, None)


def _rows(body) -> list | None:
    """Rows out of a ``hub_get`` answer; ``None`` only when the CALL failed (see the LLM twin)."""
    if body is None:
        return None
    if isinstance(body, list):
        return body
    data = body.get("data") if isinstance(body, dict) else None
    return data if isinstance(data, list) else []


def _offer(row: dict) -> APIEndpointOffer:
    target = row.get("target") if isinstance(row.get("target"), dict) else {}
    return APIEndpointOffer(
        id=str(row["id"]),
        name=str(row.get("name") or ""),
        kinds=[str(k) for k in (row.get("kinds") or [])],
        enabled=bool(row.get("enabled", True)),
        host=(urlparse(str(target.get("base_url") or "")).hostname or ""),
    )


async def fetch_hub_api_endpoints(*, cached_only: bool = False) -> list[APIEndpointOffer]:
    from flow_sdk.cli.auth.hub_login import hub_auth_available  # noqa: PLC0415
    from flow_sdk.cloud_client.transport.hub_http import hub_get  # noqa: PLC0415

    name = get_instance_settings().instance_name
    # Signed out, nothing on the hub is this box's to call -- including what it listed before
    # signing out, which the stale fallback below would otherwise hand back with no expiry.
    if not hub_auth_available():
        _list_cache.pop(name, None)
        return []
    cached = _list_cache.get(name)
    stale = cached[1] if cached is not None else []
    if cached is not None and (time.monotonic() - cached[0]) < _LIST_TTL_SECONDS:
        return stale
    if cached_only:
        return stale

    rows = _rows(await hub_get("api_endpoint"))
    if rows is None:
        return stale
    rows = list(rows) + list(_rows(await hub_get("api_endpoint", action="catalog")) or [])

    offers: list[APIEndpointOffer] = []
    seen: set[str] = set()
    for row in rows:
        if not isinstance(row, dict) or not row.get("id") or str(row["id"]) in seen:
            continue  # an endpoint the user holds a role on is ALSO in the catalog
        try:
            offers.append(_offer(row))
            seen.add(str(row["id"]))
        except Exception as exc:  # noqa: BLE001 -- one malformed row must not lose the rest
            logger.warning("fetch_hub_api_endpoints: skipped a row: %s: %s", type(exc).__name__, exc)
    _list_cache[name] = (time.monotonic(), offers)
    return offers


async def decision_endpoints(*, cached_only: bool = False) -> list[APIEndpointOffer]:
    """The enabled endpoints marked ``decision``, in the hub's order."""
    return [o for o in await fetch_hub_api_endpoints(cached_only=cached_only) if o.enabled and DECISION_KIND in o.kinds]


__all__ = ["DECISION_KIND", "decision_endpoints", "fetch_hub_api_endpoints", "invalidate_api_endpoint_listing"]
