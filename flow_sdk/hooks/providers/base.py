"""Base class for provider-specific hook file serialization."""

from abc import ABC, abstractmethod
from pathlib import Path

from flow_sdk.hooks.models import HookEntry


class ProviderHookFile(ABC):
    """Abstract base for provider-specific hook file read/write."""

    @abstractmethod
    def read(self, path: Path) -> list[HookEntry]:
        """Read hooks from file. Returns flat list of entries."""
        pass

    @abstractmethod
    def write(self, path: Path, entries: list[HookEntry]) -> None:
        """Write hooks to file."""
        pass
