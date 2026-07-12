"""SecretOrigin driver registry.

The driver is the behavior side of a secret pointer. The pointer itself remains
value-free and serializable; a driver may resolve a value only in a runtime
context such as worker process launch.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any, Optional, Protocol, runtime_checkable

from pydantic import SecretStr

if TYPE_CHECKING:
    from flow_sdk.builtin.secret_origin_locator import SecretOriginLocator


_KIND_ALIASES = {
    "hub": "flowpad-hub",
    "flowpad_hub": "flowpad-hub",
}


@runtime_checkable
class SecretOriginDriver(Protocol):
    kind: str

    def key(self, locator: "SecretOriginLocator") -> str:
        ...

    async def resolve(self, locator: "SecretOriginLocator", **context: Any) -> Optional[SecretStr]:
        ...


class SecretOriginDriverRegistry:
    def __init__(self) -> None:
        self._drivers: dict[str, SecretOriginDriver] = {}

    def register(self, driver: SecretOriginDriver) -> None:
        self._drivers[driver.kind] = driver

    def get(self, kind: str) -> SecretOriginDriver:
        name = normalize_secret_origin_kind(kind)
        try:
            return self._drivers[name]
        except KeyError as exc:
            raise KeyError(f"Unknown SecretOrigin kind: {kind!r}") from exc


def normalize_secret_origin_kind(kind: Any) -> str:
    key = str(kind or "").strip().lower()
    return _KIND_ALIASES.get(key, key)


def _build_default_registry() -> SecretOriginDriverRegistry:
    from flow_sdk.builtin.drivers.hub_secret_driver import HubSecretDriver
    from flow_sdk.builtin.drivers.local_secret_driver import LocalSecretDriver

    registry = SecretOriginDriverRegistry()
    registry.register(LocalSecretDriver())
    registry.register(HubSecretDriver())
    return registry


_DEFAULT_REGISTRY: Optional[SecretOriginDriverRegistry] = None


def get_secret_origin_registry() -> SecretOriginDriverRegistry:
    global _DEFAULT_REGISTRY
    if _DEFAULT_REGISTRY is None:
        _DEFAULT_REGISTRY = _build_default_registry()
    return _DEFAULT_REGISTRY


def get_secret_origin_driver(kind: str) -> SecretOriginDriver:
    return get_secret_origin_registry().get(kind)
