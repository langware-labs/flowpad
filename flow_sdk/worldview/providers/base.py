"""Read-only provider boundary for WorldView inventory."""

from __future__ import annotations

from typing import Protocol

from flow_sdk.worldview.models import InventorySnapshot


class InventoryProviderError(RuntimeError):
    """A provider inventory could not be started or decoded."""


class InventoryProvider(Protocol):
    name: str

    async def collect(self) -> InventorySnapshot:
        """Read the provider inventory without changing provider state."""


__all__ = ["InventoryProvider", "InventoryProviderError"]
