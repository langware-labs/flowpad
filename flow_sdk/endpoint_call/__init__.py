"""One typed call for every capability a hub ``APIEndpoint`` serves.

    image = await call(IMAGE_GENERATE, ImageRequest(prompt="a red ball"))
    clip = await call(VIDEO_GENERATE, VideoRequest(prompt="it rolls away"))
    answer = await call(DECISION, DecisionSpec(state=..., questions={...}))   # what ``decide()`` wraps

A capability is a KIND plus a request spec and a result spec (``CAPABILITIES``, in the schema layer). The caller
names the kind and hands over the request; everything vendor-specific happens below:

* the endpoint is found by what it serves, never by id -- the first one this user may call
  whose chain has a root tagged with the kind (pass ``endpoint=`` to name one). ONE endpoint
  may serve many kinds through different vendors: the hub sends each call to the root tagged
  with the kind the call names (``x-flowpad-kind``);
* the DIALECT for that (kind, vendor host) turns the request into the vendor's own calls and
  its answer back into the result. The vendor key never leaves the hub.

Every failure is an :class:`EndpointCallError` with a closed ``reason``.
"""

from __future__ import annotations

import time
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

import httpx

from flow_sdk.endpoint_call.errors import EndpointCallError, EndpointCallFailure, detail_of, reason_for
from flow_sdk.external_apis.decision.errors import DecisionError
from flow_sdk.instance_settings.api_endpoint import (
    KIND_HEADER,
    endpoints_serving,
    invalidate_api_endpoint_listing,
    sealed_endpoint,
)
from flow_sdk.schema.data_spec.api_endpoint_spec import APIEndpointOffer
from flow_sdk.schema.data_spec.endpoint_capability import CAPABILITIES, DECISION
from flow_sdk.schema.data_spec.media_spec import (
    IMAGE_GENERATE,
    VIDEO_GENERATE,
    ImageRequest,
    ImageResult,
    VideoRequest,
    VideoResult,
)
from flow_sdk.schema.data_spec.spec import DataSpec

#: A plain JSON call: long enough for a model that draws while the connection stays open.
CALL_TIMEOUT = httpx.Timeout(connect=10, write=30, read=300, pool=5)
DOWNLOAD_TIMEOUT = httpx.Timeout(connect=10, write=10, read=600, pool=5)


@lru_cache(maxsize=1)
def _dialects() -> dict[tuple[str, str], Any]:
    """(kind, vendor host) -> the module that speaks it. Imported on first use, like every vendor client."""
    from flow_sdk.external_apis.decision import jev  # noqa: PLC0415
    from flow_sdk.external_apis.image import vertex  # noqa: PLC0415
    from flow_sdk.external_apis.video import kie  # noqa: PLC0415
    from flow_sdk.external_apis.video import vertex as vertex_video  # noqa: PLC0415

    modules = (jev, vertex, kie, vertex_video)
    return {(module.KIND, host): module for module in modules for host in module.HOSTS}


def dialect_for(kind: str, host: str) -> Any:
    dialect = _dialects().get((kind, (host or "").lower()))
    if dialect is None:
        raise EndpointCallError("no_endpoint", f"No dialect speaks {kind} to {host or 'an unknown host'}")
    return dialect


class Transport:
    """The one endpoint a call goes through, with the kind already named on every request."""

    def __init__(self, offer: APIEndpointOffer, kind: str) -> None:
        self.offer = offer
        self.kind = kind

    async def exchange(
        self,
        method: str,
        sub_path: str,
        *,
        json: Any = None,
        params: Optional[dict] = None,
        timeout: Any = CALL_TIMEOUT,
        kind: Optional[str] = None,
    ) -> tuple[int, Any]:
        """One vendor request through the hub: ``(status, body)`` whatever the status -- the body parsed
        as JSON, else its first 500 characters. Raises only when the hub itself could not be reached.
        ``kind`` names another root of the same endpoint for this one request (a vendor's file store)."""
        headers = {KIND_HEADER: kind or self.kind}
        sealed = await sealed_endpoint()
        if sealed is not None and sealed.offer.id == self.offer.id:
            resp = await self._send_sealed(sealed, method, sub_path, json, params, headers, timeout)
        else:
            resp = await self._send_as_user(method, sub_path, json, params, headers, timeout)
        try:
            return resp.status_code, resp.json()
        except ValueError:
            return resp.status_code, resp.text[:500]

    async def send(self, method: str, sub_path: str, **how: Any) -> Any:
        """``exchange``, for a caller that only wants the answer: the body of a 2xx, else ``EndpointCallError``."""
        status, body = await self.exchange(method, sub_path, **how)
        if not 200 <= status < 300:
            raise EndpointCallError(
                reason_for(status, body),
                f"{self.offer.name or self.offer.typeid} answered {status}: {detail_of(body)}",
                status=status,
            )
        return body

    async def _send_as_user(self, method, sub_path, json, params, headers, timeout) -> httpx.Response:
        from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415
        from flow_sdk.cloud_client.shared.errors import HubError  # noqa: PLC0415
        from flow_sdk.cloud_client.transport.hub_http import hub_graph_url  # noqa: PLC0415

        url = hub_graph_url("api_endpoint", self.offer.id, "invoke", sub_path)
        if url is None:
            raise EndpointCallError("unavailable", "No hub is configured (offline or Local privacy mode)")
        how = {} if timeout is None else {"timeout": timeout}  # None: the hub client's own
        try:
            return await HubProxy.send(method, url, json=json, params=params, headers=headers, **how)
        except HubError as exc:
            reason: EndpointCallFailure = "auth" if exc.status_code == 401 else "unavailable"
            raise EndpointCallError(reason, f"The hub could not be reached: {exc}", status=exc.status_code) from exc

    @staticmethod
    async def _send_sealed(sealed, method, sub_path, json, params, headers, timeout) -> httpx.Response:
        """This machine's own API budget: its allocation's invoke URL, with the key the hub placed here.
        A refused key is read again once: a reset machine is given a new one, and a memo may hold the old."""
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                for attempt in (1, 2):
                    resp = await client.request(
                        method,
                        f"{sealed.url}/{sub_path.lstrip('/')}",
                        json=json,
                        params=params,
                        headers={**headers, "Authorization": f"Bearer {sealed.key}"},
                    )
                    if resp.status_code not in (401, 403) or attempt == 2:
                        return resp
                    invalidate_api_endpoint_listing()
                    fresh = await sealed_endpoint()
                    if fresh is None or fresh.key == sealed.key:
                        return resp
                    sealed = fresh
        except httpx.TimeoutException as exc:
            # The request left and no answer came back in time: not "no connection". Trying again is reasonable.
            raise EndpointCallError("timed_out", f"The hub did not answer in time ({type(exc).__name__})") from exc
        except httpx.HTTPError as exc:
            raise EndpointCallError("unavailable", f"The hub could not be reached: {type(exc).__name__}") from exc
        return resp

    async def download(self, url: str, dest: Path) -> Path:
        """A finished file at the vendor's own public URL, straight to disk (no key is involved)."""
        try:
            async with httpx.AsyncClient(timeout=DOWNLOAD_TIMEOUT, follow_redirects=True) as client:
                async with client.stream("GET", url) as resp:
                    if resp.status_code != 200:
                        raise EndpointCallError("unavailable", f"The result could not be fetched: {resp.status_code}")
                    with dest.open("wb") as out:
                        async for chunk in resp.aiter_bytes():
                            out.write(chunk)
        except httpx.HTTPError as exc:
            raise EndpointCallError("unavailable", f"The result could not be fetched: {type(exc).__name__}") from exc
        return dest


async def _serving(kind: str, endpoint: Optional[str]) -> tuple[APIEndpointOffer, str]:
    wanted = (endpoint or "").removeprefix("api_endpoint-")
    found = await endpoints_serving(kind, only=wanted)
    if found:
        return found[0]
    if wanted:
        raise EndpointCallError("no_endpoint", f"API endpoint {wanted} does not serve {kind} for this user")
    raise EndpointCallError("no_endpoint", f"No hub API endpoint this user may call serves {kind}")


async def call(
    kind: str, request: DataSpec | dict, *, endpoint: Optional[str] = None, out_dir: str | Path | None = None
) -> DataSpec:
    """Run capability ``kind`` on ``request`` and answer its result spec. Files the capability
    produces are written under ``out_dir`` (the working directory when not given)."""
    if kind not in CAPABILITIES:
        raise EndpointCallError("invalid_request", f"{kind!r} is not a capability ({', '.join(sorted(CAPABILITIES))})")
    request_spec, _result_spec = CAPABILITIES[kind]
    if not isinstance(request, request_spec):
        try:
            request = request_spec.model_validate(request.model_dump() if isinstance(request, DataSpec) else request)
        except Exception as exc:  # noqa: BLE001 -- pydantic's message IS the reason
            raise EndpointCallError("invalid_request", str(exc)) from exc
    offer, host = await _serving(kind, endpoint)
    dialect = dialect_for(kind, host)
    folder = Path(out_dir) if out_dir else Path.cwd()
    folder.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    try:
        result = await dialect.run(request, Transport(offer, kind), folder)
    except DecisionError as exc:  # the decision dialect's own word for an answer it cannot read
        raise EndpointCallError("bad_response", exc.message, status=exc.status) from exc
    return result.model_copy(
        update={"endpoint": offer.typeid, "latency_ms": round((time.perf_counter() - started) * 1000, 1)}
    )


__all__ = [
    "CAPABILITIES",
    "DECISION",
    "IMAGE_GENERATE",
    "KIND_HEADER",
    "VIDEO_GENERATE",
    "EndpointCallError",
    "EndpointCallFailure",
    "ImageRequest",
    "ImageResult",
    "Transport",
    "VideoRequest",
    "VideoResult",
    "call",
    "dialect_for",
]
