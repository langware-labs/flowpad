"""ServiceEndpoint — one service a placement exposes.

A ``Deployment`` records WHAT runs WHERE; it never said what that placement
answers on. That fact was spread over a port label on the Deployment, a
``WebApp`` row, and the hub's per-node service table. This row is the one
place it is declared: a child of the Deployment, one per exposed service.

* ``protocol`` — what it SPEAKS (``web.app``, ``api.chat.openai``, …), in the
  ``Tagged`` wire form. See ``schema/data_spec/service_endpoint_spec.py``.
* ``backend`` — how THIS machine produces the bytes: static files, or a process
  on a loopback port.
* ``check`` / ``health`` — how to tell it is alive (declared, or defaulted from the
  backend: a proxy's health path, a static root, a channel's answering loop) and
  what the last :meth:`ServiceEndpoint.health_check` found. See
  ``schema/data_spec/health_spec.py``.
* ``supports_direct_access`` — an INDICATION that a client may reach the service
  without FlowPad in the path. It grants nothing; the ``direct-url`` action
  resolves the address when asked and it is never stored.

The hub mirrors this model at the same id (``flowpad/hub/builtin/service_endpoint.py``):
its ``service`` hop lands on this tier's ``service`` route for the same endpoint,
which reaches the service over loopback. ``test_service_endpoint_model`` pins the
field set on both sides.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity, action
from flow_sdk.schema.data_spec.health_spec import (
    BuiltinCheck,
    CommandCheck,
    EndpointHealth,
    HealthCheck,
    HttpCheck,
)
from flow_sdk.schema.data_spec.service_endpoint_spec import Backend, TaggedProtocol, surface_of
from flow_sdk.schema.types import EntityType
from flow_sdk.worldview.models import DeploymentStatus


class ServiceEndpoint(Entity):
    """One exposed service of a placement. Child of its ``Deployment``."""

    type: str = APIField(default=EntityType.SERVICE_ENDPOINT.value)
    name: str = APIField(description="Unique within its deployment: 'app', 'dev', 'chat', 'workspace'")
    protocol: TaggedProtocol = APIField(description="What the service speaks — a tagged dot-path kind")
    backend: Backend = APIField(description="How this machine produces the responses")
    supports_direct_access: bool = APIField(
        default=False, description="Clients MAY reach the service without FlowPad in the path"
    )
    status: DeploymentStatus = APIField(default_factory=DeploymentStatus)
    #: The app this serves, when it serves one — a REFERENCE, like ``Deployment.artifact_id``.
    #: One local placement can serve several of a project's apps; this says which.
    artifact_id: Optional[str] = APIField(default=None, description="Referenced Artifact this serves")
    #: The webapp DEFINITION it serves (a ``micro_app`` asset), when it serves one —
    #: how a page served here finds its definition and the asset it is nested in.
    webapp_id: Optional[str] = APIField(default=None, description="Referenced WebApp definition this serves")
    #: How to tell the service is alive. ``None`` = the default for its backend (:meth:`effective_check`).
    check: Optional[HealthCheck] = APIField(default=None, description="How to tell it is alive; default by backend")
    #: What the last check found — written when the state changes, read by cards and the hub's sweep.
    health: Optional[EndpointHealth] = APIField(default=None, description="The last health check's result")

    def __init__(self, **data: Any) -> None:
        data["id"] = self.allocate_id(data)
        super().__init__(**data)

    @property
    def surface(self) -> Literal["web", "api"]:
        return surface_of(self.protocol.kind)

    # ── health ────────────────────────────────────────────────────────────

    def effective_check(self) -> HealthCheck:
        """The declared check, else the backend's own: a proxy's health path, else the backend knows."""
        if self.check is not None:
            return self.check
        if self.backend.type == "proxy":
            return HttpCheck(path="/" + str(self.backend.health or "/").lstrip("/"))
        return BuiltinCheck()

    async def health_check(self, *, record: bool = True) -> EndpointHealth:
        """Check the service now, where it runs. Never raises — a check that blew up is ``failing``.

        A row held from the hub (``remote``) runs on another machine: the hub is asked, and its answer
        is the result. ``record`` saves the result on the row when the state changed (a no-op check is
        a real no-op — no save, no broadcast).
        """
        import time  # noqa: PLC0415

        if self.remote:
            result = await self._health_from_hub()
        else:
            started = time.monotonic()
            try:
                state, detail = await self._run_check(self.effective_check())
            except Exception as exc:  # noqa: BLE001 — a check that raised is a failing service, not a crash
                state, detail = "failing", f"check raised: {exc}"
            result = EndpointHealth(
                endpoint_id=self.id,
                name=self.name,
                state=state,
                detail=detail,
                latency_ms=int((time.monotonic() - started) * 1000),
            )
        if record and not self.remote:
            await self._record_health(result)
        return result

    async def _record_health(self, result: EndpointHealth) -> None:
        if self.health is not None and self.health.state == result.state:
            return
        self.health = result
        await self.save()

    async def _run_check(self, check) -> tuple[str, str]:
        from flow_sdk.core.webpage_status import HTTP_PROBE_TIMEOUT_S  # noqa: PLC0415

        if isinstance(check, HttpCheck):
            if self.backend.type != "proxy":
                return "unknown", "an http check needs a port; this endpoint has none"
            return await _http_state(self.backend.port, check.path, HTTP_PROBE_TIMEOUT_S)
        if isinstance(check, CommandCheck):
            return await _command_state(check.cmd, HTTP_PROBE_TIMEOUT_S)
        return await self._builtin_state()

    async def _builtin_state(self) -> tuple[str, str]:
        """What the backend itself knows: a static root exists; a channel's answering loop runs."""
        from pathlib import Path  # noqa: PLC0415

        if self.backend.type == "static":
            root = Path(self.backend.root)
            return ("alive", "") if root.is_dir() else ("failing", f"{root} is missing")
        if self.backend.type == "channel":
            from flow_sdk.builtin import deployment_process  # noqa: PLC0415
            from flow_sdk.builtin.deployment import Deployment  # noqa: PLC0415

            deployment = await Deployment.get_by_typeid(self.parent_type_id) if self.parent_type_id else None
            if deployment is None:
                return "failing", "no deployment answers this channel"
            return deployment_process.loop_state(deployment)
        return "unknown", f"no builtin check for a {self.backend.type} backend"

    async def _health_from_hub(self) -> EndpointHealth:
        from flow_sdk.cloud_client.transport import hub_http  # noqa: PLC0415

        try:
            data = await hub_http.hub_get(self.get_type(), self.id, "health")
            return EndpointHealth.model_validate(data)
        except Exception as exc:  # noqa: BLE001 — the hub not answering is not the service failing
            return EndpointHealth(endpoint_id=self.id, name=self.name, state="unknown", detail=f"hub: {exc}")

    @classmethod
    async def of_deployment(cls, deployment_typeid: str) -> list["ServiceEndpoint"]:
        return await cls.get_all({"match": {"parent_type_id": str(deployment_typeid)}})

    @classmethod
    async def adopt_from_hub(cls, payload: Any) -> Optional["ServiceEndpoint"]:
        """Hold a hub endpoint here AT THE HUB'S ID (``remote``); a call on it is forwarded to the hub."""
        from flow_sdk.api.api_types.identifier import is_valid_entity_id  # noqa: PLC0415

        if not isinstance(payload, dict) or not is_valid_entity_id(str(payload.get("id") or "")):
            return None
        fields = {k: v for k, v in payload.items() if k in cls.model_fields}
        endpoint = cls(**fields)
        endpoint.remote = True
        await endpoint.save()
        return endpoint

    @classmethod
    async def find_existing(cls, deployment_typeid: str, name: str) -> Optional["ServiceEndpoint"]:
        """The endpoint *name* of *deployment_typeid*, or None — a lookup, never a derived id."""
        return next((row for row in await cls.of_deployment(deployment_typeid) if row.name == name), None)

    # ── actions ───────────────────────────────────────────────────────────

    @action.all(action_name="service")
    async def service_action(self):
        """``service_endpoint/<id>/service/<path>`` — the pure proxy.

        Declared so the path parses into this action like any other. The bytes
        are moved by ``server/routes/service_endpoint.py``, mounted ahead of the
        graph catch-all (the graph reads bodies and has no WebSocket route).
        Reaching this handler means that router was not mounted.
        """
        from flow_sdk.responses.response import ApiFailResponse  # noqa: PLC0415

        return ApiFailResponse(message="the service proxy is not mounted on this instance", status_code=501)

    @action.get(action_name="direct-url")
    async def direct_url_action(self, redirect: bool | str = False):
        """``GET service_endpoint/<id>/direct-url`` — the service's own address, resolved now.

        Never stored: an address names the machine as it is at this moment. A
        cloud row asks the hub, which wakes the machine it runs on. A row on this
        machine answers ``localhost`` on a desktop and the box's public host inside
        a sandbox (the viewer is not at the box). ``supports_direct_access`` is the
        endpoint's claim that a client may use this — it grants nothing.
        """
        from fastapi.responses import RedirectResponse  # noqa: PLC0415

        from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse  # noqa: PLC0415

        if not self.supports_direct_access:
            return ApiFailResponse(message="this endpoint does not support direct access", status_code=409)
        if self.backend.type != "proxy":
            return ApiFailResponse(message="a static endpoint has no address of its own", status_code=409)
        if self.remote:
            url = await self._direct_url_from_hub()
            if url is None:
                return ApiFailResponse(message="the hub did not resolve this cloud endpoint", status_code=502)
        else:
            url = local_direct_url(self.backend.port)
        if str(redirect).lower() in ("1", "true", "yes"):
            return RedirectResponse(url, status_code=302, headers={"Cache-Control": "no-store"})
        return ApiSuccessResponse(data={"url": url})

    @action.post(action_name="probe")
    async def probe_action(self):
        """``POST service_endpoint/<id>/probe`` — what is wrong with the service, from where it runs.

        The browser can only see "the frame loaded" (a refused port still fires
        ``onload``); this answers why, from the machine the service is on: a
        loopback request to its port and health path. Always a result — a probe
        that failed says so in ``probe_error``.
        """
        from flow_sdk.core.webapp_probe import probe_webapp  # noqa: PLC0415
        from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse  # noqa: PLC0415

        if self.backend.type != "proxy":
            return ApiFailResponse(message="a static endpoint has no process to probe", status_code=409)
        if self.remote:
            return ApiFailResponse(message="this endpoint runs on another machine", status_code=409)
        port = self.backend.port
        health = "/" + str(self.backend.health or "/").lstrip("/")
        return ApiSuccessResponse(data=await probe_webapp(f"http://127.0.0.1:{port}{health}", port))

    @action.get(action_name="health")
    async def health_action(self):
        """``GET service_endpoint/<id>/health`` — check the service now; answers an ``EndpointHealth``."""
        from flow_sdk.responses.response import ApiSuccessResponse  # noqa: PLC0415

        return ApiSuccessResponse(data=(await self.health_check()).model_dump(mode="json"))

    async def _direct_url_from_hub(self) -> Optional[str]:
        from flow_sdk.cloud_client.transport import hub_http  # noqa: PLC0415

        data = await hub_http.hub_get(self.get_type(), self.id, "direct-url")
        return str(data.get("url") or "") or None if isinstance(data, dict) else None


def local_direct_url(port: int) -> str:
    """Where a BROWSER reaches *port* on this machine.

    ``localhost`` on a desktop, where the viewer sits at the machine. Inside a
    cloud box the viewer does not, so the box's public per-port host is the
    answer. The probe asks the other question — where the port is from HERE —
    and loopback is right for it on both.
    """
    from flow_sdk.compute.providers.compute_provider import sandbox_public_url  # noqa: PLC0415
    from flow_sdk.instance_settings.runtime import own_sandbox_id  # noqa: PLC0415

    sandbox_id = own_sandbox_id()
    return sandbox_public_url(int(port), sandbox_id) if sandbox_id else f"http://localhost:{int(port)}"


async def _http_state(port: int, path: str, timeout: float) -> tuple[str, str]:
    """``alive`` when anything HTTP answers below 500 on the loopback port.

    Below 500, not below 400: a 401/403 (a gated box, an MCP server that wants a session) is a server
    that is up and refusing, which is alive. A refused connection or a 5xx is failing.
    """
    import httpx  # noqa: PLC0415

    url = f"http://127.0.0.1:{int(port)}/{str(path or '/').lstrip('/')}"
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
            response = await client.get(url)
    except httpx.HTTPError as exc:
        return "failing", f"{url}: {type(exc).__name__}"
    if response.status_code >= 500:
        return "failing", f"{url} answered {response.status_code}"
    return "alive", ""


async def _command_state(cmd: str, timeout: float) -> tuple[str, str]:
    """``alive`` when *cmd* exits 0 on this machine within *timeout* (a check that never answers is failing)."""
    import asyncio  # noqa: PLC0415

    process = await asyncio.create_subprocess_shell(
        cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
    )
    try:
        out, _ = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        process.kill()
        return "failing", f"{cmd!r} did not answer"
    if process.returncode == 0:
        return "alive", ""
    return "failing", (out or b"").decode(errors="replace").strip()[-300:] or f"exit {process.returncode}"


__all__ = ["ServiceEndpoint", "local_direct_url"]
