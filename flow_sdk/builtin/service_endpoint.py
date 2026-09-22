"""ServiceEndpoint — one service a placement exposes.

A ``Deployment`` records WHAT runs WHERE; it never said what that placement
answers on. That fact was spread over a port label on the Deployment, a
``WebApp`` row, and the hub's per-node service table. This row is the one
place it is declared: a child of the Deployment, one per exposed service.

* ``protocol`` — what it SPEAKS (``web.app``, ``api.chat.openai``, …), in the
  ``Tagged`` wire form. See ``schema/data_spec/service_endpoint_spec.py``.
* ``backend`` — how THIS machine produces the bytes: static files, or a process
  on a loopback port.
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

    def __init__(self, **data: Any) -> None:
        data["id"] = self.allocate_id(data)
        super().__init__(**data)

    @property
    def surface(self) -> Literal["web", "api"]:
        return surface_of(self.protocol.kind)

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


__all__ = ["ServiceEndpoint", "local_direct_url"]
