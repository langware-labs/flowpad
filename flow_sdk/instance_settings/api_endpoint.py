"""Hub ``APIEndpoint``s this box's user may call -- listed the way LLM endpoints are.

``fetch_hub_llm_endpoints`` (``instance_settings/llm_endpoint.py``) is the model and every
rule here is its rule, for the same reason:

* TWO reads, unioned. The type listing is access-scoped (rows the user holds a role on); an
  endpoint opened to every signed-in user carries no role edge, only an
  ``authenticated_roles`` stamp, so it is in the ``catalog`` alone. A shared Jev endpoint is
  exactly that case.
* ``[]`` when signed out, without asking (an idle box must not collect 401 toasts).
* A 30-second memo; ``cached_only`` answers from it and never calls out; a failed refresh
  keeps the last good list rather than emptying it.
* Through ``HubProxy.try_call``: the one chokepoint that honours Local privacy mode.

Finding a DECISION endpoint is then a filter on ``kinds``, not a hub query: the hub stores
the tag, the caller keeps the kinds it needs.

A machine with no hub login (an invite box) lists nothing. It may still hold a SEALED endpoint:
the hub placed its own allocation's invoke URL, a key that can only invoke it, and what it serves
(``sealed_endpoint``). That one is offered last, and called with the key instead of a login.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from dataclasses import dataclass, field
from urllib.parse import urlparse

from flow_sdk.instance_settings import get_instance_settings
from flow_sdk.schema.data_spec.api_endpoint_spec import APIEndpointOffer

logger = logging.getLogger(__name__)

DECISION_KIND = "decision"
#: The header the hub reads the kind from. It is the hub's business only: never forwarded.
KIND_HEADER = "x-flowpad-kind"
_LIST_TTL_SECONDS = 30.0
#: instance name -> (fetched_at, offers)
_list_cache: dict[str, tuple[float, list[APIEndpointOffer]]] = {}
#: "<instance>:<endpoint id>" -> (fetched_at, {kind: vendor host})
_serves_cache: dict[str, tuple[float, dict[str, str]]] = {}


#: What the hub places on a machine it gives an API budget to (hub ``agent_visitor_deployment``).
SEALED_URL_VAR = "FLOWPAD_API_ENDPOINT_URL"
SEALED_KEY_VAR = "FLOWPAD_API_ENDPOINT_KEY"
SEALED_SERVES_VAR = "FLOWPAD_API_ENDPOINT_SERVES"
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_SEALED_VARS = (SEALED_URL_VAR, SEALED_KEY_VAR, SEALED_SERVES_VAR)
#: (fetched_at, the sealed endpoint or None). A reset machine gets a new key: never kept for long.
_sealed_cache: tuple[float, "SealedEndpoint | None"] | None = None


@dataclass(frozen=True)
class SealedEndpoint:
    """This machine's own API budget: called at ``url`` with ``key``, never through a hub login."""

    offer: APIEndpointOffer
    url: str
    key: str = field(repr=False)
    serves: dict[str, str] = field(default_factory=dict)


async def _placed(names: tuple[str, ...]) -> dict[str, str]:
    """``names`` from the environment, else from where the hub places a machine's values."""
    found = {name: os.environ[name] for name in names if os.environ.get(name)}
    if len(found) == len(names):
        return found
    try:
        from flow_sdk.builtin.credential_resolver import resolve_project_secrets  # noqa: PLC0415

        placed = await resolve_project_secrets(None, only=names)
    except Exception as exc:  # noqa: BLE001 -- a machine with no store simply has no sealed endpoint
        logger.debug("sealed endpoint: could not read placed values: %s", type(exc).__name__)
        placed = {}
    return {**{name: value.get_secret_value() for name, value in placed.items()}, **found}


async def sealed_endpoint() -> SealedEndpoint | None:
    global _sealed_cache  # noqa: PLW0603 -- a module memo, like the listing's
    if _sealed_cache is not None and (time.monotonic() - _sealed_cache[0]) < _LIST_TTL_SECONDS:
        return _sealed_cache[1]
    values = await _placed(_SEALED_VARS)
    url, key = values.get(SEALED_URL_VAR, "").rstrip("/"), values.get(SEALED_KEY_VAR, "")
    sealed = None
    if url and key:
        try:
            serves = json.loads(values.get(SEALED_SERVES_VAR) or "{}")
        except ValueError:
            serves = {}
        serves = {str(k): str(v) for k, v in serves.items()} if isinstance(serves, dict) else {}
        named = _UUID.search(url)  # the allocation's id is in its invoke URL
        endpoint_id = named.group(0) if named else "sealed"
        offer = APIEndpointOffer(id=endpoint_id, name="this machine's API budget", kinds=sorted(serves))
        sealed = SealedEndpoint(offer=offer, url=url, key=key, serves=serves)
    _sealed_cache = (time.monotonic(), sealed)
    return sealed


def invalidate_api_endpoint_listing() -> None:
    global _sealed_cache  # noqa: PLW0603
    _list_cache.pop(get_instance_settings().instance_name, None)
    _serves_cache.clear()
    _sealed_cache = None


def _rows(body) -> list | None:
    """Rows out of a ``HubProxy.try_call`` answer; ``None`` only when the CALL failed (see the LLM twin)."""
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
    from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415

    name = get_instance_settings().instance_name
    cached = _list_cache.get(name)
    stale = cached[1] if cached is not None else []
    if cached is not None and (time.monotonic() - cached[0]) < _LIST_TTL_SECONDS:
        return stale
    if cached_only or not hub_auth_available():
        return stale

    rows = _rows(await HubProxy.try_call("GET", "api_endpoint"))
    if rows is None:
        return stale
    rows = list(rows) + list(_rows(await HubProxy.try_call("GET", "api_endpoint", action="catalog")) or [])

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
    """The enabled endpoints that serve ``decision``, in the hub's order, each with the vendor host that
    answers decisions through it (a root's own; an allocation's, read from its chain)."""
    served = await endpoints_serving(DECISION_KIND, cached_only=cached_only)
    return [offer.model_copy(update={"host": host}) for offer, host in served]


async def _chain_serves(endpoint_id: str, *, cached_only: bool = False) -> dict[str, str]:
    """``{kind: vendor host}`` of what an ALLOCATION reaches through its chain, as the hub reports it
    (``api_endpoint/<id>/chain`` -> ``serves``). Memoised like the listing, and like it ``cached_only``
    never calls out; ``{}`` when the read fails."""
    from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415

    key = f"{get_instance_settings().instance_name}:{endpoint_id}"
    cached = _serves_cache.get(key)
    if cached is not None and (cached_only or (time.monotonic() - cached[0]) < _LIST_TTL_SECONDS):
        return cached[1]
    if cached_only:
        return {}
    body = await HubProxy.try_call("GET", "api_endpoint", endpoint_id, "chain", quiet=True)
    report = body.get("data") if isinstance(body, dict) and isinstance(body.get("data"), dict) else body
    serves = report.get("serves") if isinstance(report, dict) else None
    found = {str(k): str(v) for k, v in serves.items()} if isinstance(serves, dict) else {}
    if body is not None:
        _serves_cache[key] = (time.monotonic(), found)
    return found


async def endpoints_serving(
    kind: str, *, cached_only: bool = False, only: str = ""
) -> list[tuple[APIEndpointOffer, str]]:
    """``(endpoint, vendor host)`` for every enabled endpoint this user may call that serves ``kind``
    (just endpoint id ``only``, when given), in the hub's order. A ROOT serves the kinds it is tagged
    with, at its own host. An allocation has no vendor of its own -- one may draw on several roots, a
    video API and an image API behind one id -- so what it serves is read from its chain."""

    async def host_of(offer: APIEndpointOffer) -> str:
        if offer.host:
            return offer.host if kind in offer.kinds else ""
        return (await _chain_serves(offer.id, cached_only=cached_only)).get(kind, "")

    offers = [
        offer
        for offer in await fetch_hub_api_endpoints(cached_only=cached_only)
        if offer.enabled and (not only or offer.id == only)
    ]
    hosts = await asyncio.gather(*(host_of(offer) for offer in offers))
    found = [(offer, host) for offer, host in zip(offers, hosts) if host]
    sealed = None if cached_only and _sealed_cache is None else await sealed_endpoint()
    if sealed is not None and kind in sealed.serves and (not only or sealed.offer.id == only):
        found.append((sealed.offer, sealed.serves[kind]))
    return found


__all__ = [
    "DECISION_KIND",
    "KIND_HEADER",
    "SealedEndpoint",
    "decision_endpoints",
    "endpoints_serving",
    "fetch_hub_api_endpoints",
    "invalidate_api_endpoint_listing",
    "sealed_endpoint",
]
