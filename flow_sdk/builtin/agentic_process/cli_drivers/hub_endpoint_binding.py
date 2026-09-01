"""Bind / unbind this box to a hub ``LLMEndpoint``, and report what funds each harness.

The hub, after it has logged the box in, pushes ONE thing over the box's own loopback API
(``llm-endpoint`` action on ``compute_node/@local``): the identity and hub-relative invoke
path of the endpoint this box may spend. This module persists that binding and reports the
box's funding picture back.

**A binding is an offer, not an order.** It used to be an order: binding rewrote every
hub-capable harness to ``auth_mode="api"`` / ``api_provider="flowpad"``, and unbinding
rewrote them to ``device``. That ran on every workspace open, kept no record of what it
replaced, and so silently discarded a user's device or OpenRouter choice -- while
``Capability`` itself documents that seeding must never clobber those very fields. It was
not a design requirement either: it existed only because ``resolve_worker_api_auth``
refused to consider any provider unless ``auth_mode == "api"``. With that gate gone,
``resolve_llm_source`` reaches the endpoint on its own -- and on a bound box an unproven
device login yields to it -- so the write has no reason to exist.

Which means ``active_for`` now means what it says: the harnesses whose RESOLVED source is
the bound endpoint, asked of the same resolver a spawn uses, rather than a proxy field
this module had just written itself.
"""

from __future__ import annotations

import logging

from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import _SPECS
from flow_sdk.instance_settings.llm_endpoint import (
    HubLLMEndpoint,
    clear_hub_llm_endpoint,
    fetch_hub_llm_endpoints,
    get_hub_llm_endpoint,
    hub_llm_endpoint_invoke_url,
    set_hub_llm_endpoint,
)

logger = logging.getLogger(__name__)

#: The harnesses whose ``ApiAuthSpec`` carries a hub binding -- derived, so a
#: driver that gains/loses one is picked up here without a second list.
HUB_ENDPOINT_HARNESSES: tuple[str, ...] = tuple(
    worker for worker, spec in _SPECS.items() if spec.hub_endpoint_binding is not None
)


class HubEndpointBindError(Exception):
    """A bind that cannot be honoured; ``status_code`` maps onto the HTTP answer."""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


async def _sources_by_kind() -> tuple[dict, dict]:
    """``(sources, resolved)`` for every hub-capable harness, keyed by capability kind.

    Reads only what is already local (including the endpoint memo), so this adds no
    round-trip to a status the harness picker polls.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_capability_kind
    from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import list_llm_sources, pick_llm_source

    sources: dict[str, list] = {}
    resolved: dict[str, dict | None] = {}
    for worker in HUB_ENDPOINT_HARNESSES:
        kind = worker_capability_kind(worker)
        listed = await list_llm_sources(worker)
        chosen = pick_llm_source(listed)
        sources[kind] = [s.model_dump(mode="json") for s in listed]
        resolved[kind] = chosen.model_dump(mode="json") if chosen else None
    return sources, resolved


async def _status(hub_logged_in: bool, *, refresh: bool = False) -> dict:
    bound: HubLLMEndpoint | None = get_hub_llm_endpoint()
    # Read the endpoint listing FIRST, then build the sources from the now-warm memo.
    # ``_inventory`` is memo-only by design (it runs in the spawn path and must not call
    # out), so computing sources before this ran left every endpoint out of the FIRST
    # answer and put it in the second -- a picker that fills in on its own second poll.
    available = await fetch_hub_llm_endpoints(cached_only=not refresh)
    sources, resolved = await _sources_by_kind()
    bound_typeid = bound.endpoint_typeid if bound else ""
    return {
        # Every endpoint this user could be pointed at, not just the one the hub pushed -- the
        # picker needs the alternatives, and a process may name any of them. Empty when logged out
        # or when the hub is unreachable; never an error, because this rides the status the harness
        # modal polls. Only the READ path refreshes: bind/unbind are called BY the hub, and calling
        # back into it mid-request would make its call wait on its own second call.
        "available": [endpoint.to_wire() for endpoint in available],
        "endpoint_typeid": bound.endpoint_typeid if bound else None,
        "invoke_path": bound.invoke_path if bound else None,
        "invoke_url": hub_llm_endpoint_invoke_url(),
        "provider": bound.provider if bound else None,
        "name": bound.name if bound else None,
        "hub_logged_in": hub_logged_in,
        # Every source each harness could be funded by, and which one actually wins. One
        # producer for the resolver and the picker, so what a spawn does and what the UI
        # claims cannot disagree.
        "sources": sources,
        "resolved": resolved,
        # Harnesses whose resolved source IS the bound endpoint. This used to mean "whose
        # Capability was flipped to (api, flowpad)" -- a proxy for the answer rather than the
        # answer. Now that binding no longer rewrites the user's preference, the honest
        # reading is the resolver's own.
        "active_for": [
            kind
            for kind, pick in resolved.items()
            if pick and pick.get("kind") == "endpoint" and pick.get("endpoint_typeid") == bound_typeid and bound_typeid
        ],
    }


async def hub_llm_endpoint_status() -> dict:
    """What the box is bound to and which harnesses actually route through it."""
    from flow_sdk.cli.auth.hub_login import resolve_hub_api_key

    return await _status(bool(resolve_hub_api_key()), refresh=True)


async def bind_hub_llm_endpoint(payload: dict) -> dict:
    """Persist the hub's binding and return the status.

    Raises ``HubEndpointBindError(400)`` on a malformed payload and ``(409)`` when the box
    holds no hub login key -- a binding the box cannot sign for is not a binding, and the
    hub calls this only after login, so 409 means "wrong order".

    **This no longer rewrites any ``Capability``.** It used to force every hub-capable
    harness to ``auth_mode="api"`` / ``api_provider="flowpad"``, on every workspace open,
    with no memory of what it replaced -- silently discarding a user's device or
    OpenRouter choice while ``Capability`` itself documents that seeding must never
    clobber that field. That write was a workaround for a resolver gate that no longer
    exists: ``resolve_llm_source`` reaches the endpoint on its own, and on a bound box an
    unproven device login yields to it. A binding is now an OFFER, and the box picks.
    """
    from flow_sdk.cli.auth.hub_login import resolve_hub_api_key

    if not resolve_hub_api_key():
        raise HubEndpointBindError("box is not logged in to the hub; log it in before binding an LLM endpoint", 409)
    try:
        bound = set_hub_llm_endpoint(
            payload.get("endpoint_typeid"),
            payload.get("invoke_path"),
            provider=payload.get("provider"),
            name=payload.get("name"),
        )
    except ValueError as exc:
        raise HubEndpointBindError(str(exc), 400) from exc

    logger.info(f"[llm-endpoint] box bound to hub endpoint {bound.endpoint_typeid}")
    return await _status(hub_logged_in=True)


async def unbind_hub_llm_endpoint() -> dict:
    """Drop the binding and return the status.

    Nothing to revert any more: binding stopped writing to ``Capability``, so unbinding
    simply removes the offer and the resolver falls back down the ladder on its own.
    """
    from flow_sdk.cli.auth.hub_login import resolve_hub_api_key

    was_bound = clear_hub_llm_endpoint()
    status = await _status(bool(resolve_hub_api_key()))
    return {**status, "was_bound": was_bound}
