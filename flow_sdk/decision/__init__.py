"""Take a decision through the hub ``APIEndpoint`` marked ``decision``.

    result = await decide(DecisionSpec(state=..., questions={...}))
    result.pick("target", min=0.85)     # the option, or None when not sure

The endpoint is found by what it IS, not by id: ``decision_endpoints()`` lists what this
user may call (scoped listing + catalog) and keeps ``kinds`` containing ``"decision"``. Pass
``endpoint=`` (an id or ``api_endpoint-<id>``) to name one instead. The box adds its own hub
login; the vendor key never leaves the hub.

Every failure is a :class:`DecisionError` with a closed ``reason``. A decision is an
optimisation, never a dependency -- a caller that cannot get one takes the ordinary path.
"""

from __future__ import annotations

import time
from typing import Optional

from flow_sdk.external_apis.decision import DecisionError, DecisionFailure, dialect_for_host, failure_detail, reason_for_status
from flow_sdk.instance_settings.api_endpoint import decision_endpoints, fetch_hub_api_endpoints
from flow_sdk.schema.data_spec.api_endpoint_spec import APIEndpointOffer
from flow_sdk.schema.data_spec.decision_spec import (
    ChoiceAnswer,
    ChoiceQuestion,
    DecisionResult,
    DecisionSpec,
    DecisionWire,
    ScoreAnswer,
    ScoreQuestion,
    YesNoAnswer,
    YesNoQuestion,
)


async def _endpoint(endpoint: Optional[str]) -> APIEndpointOffer:
    if endpoint:
        wanted = endpoint.removeprefix("api_endpoint-")
        for offer in await fetch_hub_api_endpoints():
            if offer.id == wanted:
                return offer
        raise DecisionError("no_endpoint", f"API endpoint {wanted} is not one this user may call")
    offers = await decision_endpoints()
    if not offers:
        raise DecisionError("no_endpoint", "No hub API endpoint is marked as a decision API")
    return offers[0]


async def decide(spec: DecisionSpec | dict, *, endpoint: Optional[str] = None) -> DecisionResult:
    from flow_sdk.cloud_client.transport.hub_http import HubError, hub_invoke_raw  # noqa: PLC0415

    if not isinstance(spec, DecisionSpec):
        try:
            spec = DecisionSpec.model_validate(spec)
        except Exception as exc:  # noqa: BLE001 -- pydantic's message IS the reason
            raise DecisionError("invalid_spec", str(exc)) from exc
    offer = await _endpoint(endpoint)
    dialect = dialect_for_host(offer.host)
    sent = dialect.to_wire(spec)
    # The call itself, recorded as it happens: on the result when it succeeds, on the error when not.
    wire = DecisionWire(endpoint=offer.typeid, path=dialect.PATH, request=sent)
    started = time.perf_counter()
    try:
        status, body = await hub_invoke_raw("api_endpoint", offer.id, dialect.PATH, sent)
    except HubError as exc:
        raise DecisionError(
            "auth" if exc.status == 401 else "unavailable",
            f"The hub could not be reached: {exc}",
            status=exc.status,
            wire=wire.model_copy(update={"status": exc.status or 0}),
        ) from exc
    wire = wire.model_copy(update={"status": status, "response": body})
    if status == 0:
        raise DecisionError("unavailable", "No hub is configured (offline or Local privacy mode)", wire=wire)
    if status != 200:
        detail = failure_detail(body)
        raise DecisionError(
            reason_for_status(status), f"The decision endpoint answered {status}: {detail}", status=status, wire=wire
        )
    result = dialect.from_wire(spec, body).model_copy(
        update={"latency_ms": round((time.perf_counter() - started) * 1000, 1), "endpoint": offer.typeid}
    )
    result._wire = wire
    return result


__all__ = [
    "ChoiceAnswer",
    "ChoiceQuestion",
    "DecisionError",
    "DecisionFailure",
    "DecisionResult",
    "failure_detail",
    "DecisionSpec",
    "ScoreAnswer",
    "ScoreQuestion",
    "YesNoAnswer",
    "YesNoQuestion",
    "decide",
    "decision_endpoints",
]
