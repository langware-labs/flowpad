"""Optional runtime status, fetched after SDK initialization."""

from typing import Any, ClassVar

from flow_sdk.schema.data_spec.spec import DataSpec


class DeferredDesktopInfo(DataSpec):
    llm_providers: list[str] = []
    installed_agents: list[str] = []
    cloud_login_available: bool | None = None


class DeferredInfo(DataSpec):
    spec_kind: ClassVar[str] = "runtime.info"

    desktop_info: DeferredDesktopInfo | None = None
    scan_info: dict[str, Any] | None = None
    harness_state: dict[str, Any] | None = None
    capabilities_summary: dict[str, Any] | None = None
    sandbox_available: bool | None = None
    sandbox_compute_node: dict[str, Any] | None = None
    sniffer_hook: dict[str, Any] | None = None
    sniffer_installed: bool | None = None
    notice: dict[str, Any] | None = None
