"""Bind / unbind this box's coding-CLI harnesses to a hub ``LLMEndpoint``.

The hub, after it has logged the box in, pushes ONE thing over the box's own
loopback API (``llm-endpoint`` action on ``compute_node/@local``): the identity
and hub-relative invoke path of the endpoint the harnesses should route
through. This module is what that action does:

* persist the binding (``instance_settings/llm_endpoint.py``);
* flip every harness that can use it (claude/codex/copilot) to
  ``auth_mode="api"``, ``api_provider="flowpad"`` -- the same fields the modal's
  ``setAuthMode`` writes, so the UI reflects it live and ``resolve_worker_api_auth``
  spawns with the hub binding on the next turn.

Unbinding reverts those harnesses to ``device``: leaving them on ``api``/``flowpad``
with no endpoint would fail every spawn loudly for no reason.
"""

from __future__ import annotations

import logging

from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import _SPECS
from flow_sdk.flowpad_types.enums.lm_provider_enums import LMApiProvider
from flow_sdk.instance_settings.llm_endpoint import (
    HubLLMEndpoint,
    clear_hub_llm_endpoint,
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


async def _harness_capabilities() -> list[tuple[str, object]]:
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_capability_kind
    from flow_sdk.builtin.capability import Capability

    out = []
    for worker in HUB_ENDPOINT_HARNESSES:
        kind = worker_capability_kind(worker)
        cap = await Capability.get_by_kind(kind)
        if cap is not None:
            out.append((kind, cap))
    return out


def _status(capabilities: list[tuple[str, object]], hub_logged_in: bool) -> dict:
    bound: HubLLMEndpoint | None = get_hub_llm_endpoint()
    return {
        "endpoint_typeid": bound.endpoint_typeid if bound else None,
        "invoke_path": bound.invoke_path if bound else None,
        "invoke_url": hub_llm_endpoint_invoke_url(),
        "provider": bound.provider if bound else None,
        "name": bound.name if bound else None,
        "hub_logged_in": hub_logged_in,
        "active_for": [
            kind
            for kind, cap in capabilities
            if cap.auth_mode == "api" and cap.api_provider == LMApiProvider.FLOWPAD.value
        ],
    }


async def hub_llm_endpoint_status() -> dict:
    """What the box is bound to and which harnesses actually route through it."""
    from flow_sdk.cli.auth.hub_login import resolve_hub_api_key

    return _status(await _harness_capabilities(), bool(resolve_hub_api_key()))


async def bind_hub_llm_endpoint(payload: dict) -> dict:
    """Persist the hub's binding and switch the harnesses onto it. Returns the status.

    Raises ``HubEndpointBindError(400)`` on a malformed payload and ``(409)`` when
    the box holds no hub login key -- a binding the box cannot sign for is not a
    binding, and the hub calls this only after login, so 409 means "wrong order".
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

    capabilities = await _harness_capabilities()
    for kind, cap in capabilities:
        if cap.auth_mode == "api" and cap.api_provider == LMApiProvider.FLOWPAD.value:
            continue
        cap.auth_mode = "api"
        cap.api_provider = LMApiProvider.FLOWPAD.value
        await cap.save(notify=True)
        logger.info(f"[llm-endpoint] {kind}: routed through hub endpoint {bound.endpoint_typeid}")
    return _status(capabilities, hub_logged_in=True)


async def unbind_hub_llm_endpoint() -> dict:
    """Drop the binding and revert harnesses that were on it to device login."""
    from flow_sdk.cli.auth.hub_login import resolve_hub_api_key

    was_bound = clear_hub_llm_endpoint()
    reverted: list[str] = []
    capabilities = await _harness_capabilities()
    for kind, cap in capabilities:
        if cap.api_provider != LMApiProvider.FLOWPAD.value:
            continue
        cap.auth_mode = "device"
        cap.api_provider = None
        await cap.save(notify=True)
        reverted.append(kind)
    status = _status(capabilities, bool(resolve_hub_api_key()))
    return {**status, "was_bound": was_bound, "reverted": reverted}
