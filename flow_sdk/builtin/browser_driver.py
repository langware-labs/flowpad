"""BrowserDriver — the indexed row of a browser driver (``agentic-assets/browser_driver/<name>/``).

Which driver a session gets is ``agentic_process/browser_choice``; the driver renders what that
session is told about its browser. The row's actions are what its editor and the footer menu
call: this machine's config, its state per worker, and starting or closing a managed window.
"""
from __future__ import annotations

import asyncio
from typing import ClassVar, Optional

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.core import Entity
from flow_sdk.core import action as core_action
from flow_sdk.schema.data_spec.browser_driver_spec import BrowserMcpSpec, BrowserProbe, WorkerSetupSpec
from flow_sdk.schema.data_spec.secret_manager_spec import ConfigFieldSpec
from flow_sdk.schema.types import EntityType


class BrowserDriver(Entity):
    """The ROW; its shape on disk is ``BrowserDriverSpec`` (``TypeInfo.asset_spec``)."""

    type: str = APIField(default=EntityType.BROWSER_DRIVER.value)

    # A folder-backed asset owns its path. PRIVATE: the path is this machine's.
    asset_ref: Optional[str] = APIField(None, sharing=Sharing.PRIVATE)

    title: str = APIField(default="")
    description: str = APIField(default="")
    icon: str = APIField(default="")
    workers: dict[str, WorkerSetupSpec] = APIField(default_factory=dict)
    mcp: Optional[BrowserMcpSpec] = APIField(default=None)
    managed: bool = APIField(default=False)
    apps: list[str] = APIField(default_factory=list)
    probe: BrowserProbe = APIField(default=BrowserProbe.CDP)
    config_fields: list[ConfigFieldSpec] = APIField(default_factory=list)
    defaults: dict[str, str] = APIField(default_factory=dict)
    tool_prefixes: list[str] = APIField(default_factory=list)
    install_url: str = APIField(default="")

    _api_visible: ClassVar[bool] = True

    def system_instructions(self) -> str:
        """What a session using this browser is told — the driver's own ``instructions.md``."""
        from flow_sdk.core import browser_drivers  # noqa: PLC0415

        return browser_drivers.instructions_for(self.name or "")

    async def _describe(self) -> dict:
        """This machine's view of the driver: its config, the apps it could run that are installed
        here, its state for every worker, and the text a session gets. Starts nothing."""
        from flow_sdk.builtin.agentic_process import browser_choice  # noqa: PLC0415
        from flow_sdk.core import browser_drivers  # noqa: PLC0415
        from flow_sdk.core.browser_profiles import app_binary, app_def  # noqa: PLC0415
        from flow_sdk.flowpad_types.vendors import VENDORS  # noqa: PLC0415

        name = self.name or ""

        def read() -> dict:
            hint = browser_choice.extension_hint()
            # A managed window is the same for every worker: probe it once.
            window = browser_drivers.window_state(name) if self.managed else ""
            workers = []
            for vendor in VENDORS:
                setup = browser_drivers.worker_setup(name, vendor.key)
                workers.append({
                    "worker": vendor.key,
                    "label": vendor.label,
                    "state": browser_drivers.state_of(name, vendor.key, has_switch=browser_choice.has_switch(vendor.key),
                                                      extension_installed=bool(hint.get("installed")), window=window),
                    "setup": setup.setup if setup is not None else "",
                })
            apps = [{"id": app, "name": (app_def(app).name if app_def(app) else app), "installed": bool(app_binary(app))}
                    for app in self.apps]
            return {"config": browser_drivers.read_config(name), "apps": apps, "workers": workers,
                    "instructions": browser_drivers.instructions_for(name)}

        return await asyncio.to_thread(read)

    @core_action.get(action_name="describe")
    async def describe_action(self):
        """`GET /browser_driver/<id>/describe` — config, installed apps, state per worker, instructions."""
        from flow_sdk.responses.response import ApiSuccessResponse  # noqa: PLC0415

        return ApiSuccessResponse(data=await self._describe())

    @core_action.post(action_name="config")
    async def config_action(self, config: Optional[dict] = None):
        """`POST /browser_driver/<id>/config {config}` — save this machine's settings for the driver
        (app, profile, port). A session reads them at its next browser call."""
        from flow_sdk.core import browser_drivers  # noqa: PLC0415
        from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse  # noqa: PLC0415

        try:
            browser_drivers.write_config(self.name or "", config or {})
        except browser_drivers.BrowserConfigError as exc:
            return ApiFailResponse(message=str(exc), status_code=400)
        return ApiSuccessResponse(data=await self._describe())

    @core_action.post(action_name="window")
    async def window_action(self, change: str = ""):
        """`POST /browser_driver/<id>/window {change: open|close}` — start, or close, the window a
        MANAGED driver owns. Closing never touches a browser the person started themselves."""
        from flow_sdk.core import agent_browser  # noqa: PLC0415
        from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse  # noqa: PLC0415

        if not self.managed:
            return ApiFailResponse(message=f"{self.title or self.name} has no window of Flowpad's own", status_code=400)
        if change not in ("open", "close"):
            return ApiFailResponse(message="change must be open or close", status_code=400)
        try:
            if change == "open":
                await asyncio.to_thread(agent_browser.ensure_running, None, self.name or "")
            else:
                await asyncio.to_thread(agent_browser.stop, None, self.name or "")
        except agent_browser.AgentBrowserError as exc:
            return ApiFailResponse(message=str(exc), status_code=409)
        return ApiSuccessResponse(data=await self._describe())
