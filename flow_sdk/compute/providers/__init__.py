"""Compute provider factory and registry."""

from .compute_provider import ComputeProvider
from .desktop import LocalComputeProvider

__all__ = ["ComputeProvider", "LocalComputeProvider", "get_compute_provider"]

# Provider registry
_providers: dict[str, ComputeProvider] = {}


def get_compute_provider(provider_type: str) -> ComputeProvider:
    """Get or create a compute provider singleton.

    Args:
        provider_type: The type of provider ("local_machine", etc.)

    Returns:
        ComputeProvider instance

    Raises:
        ValueError: If provider type is unknown
    """
    if provider_type == "local_machine":
        if "local_machine" not in _providers:
            _providers["local_machine"] = LocalComputeProvider()
        return _providers["local_machine"]
    else:
        raise ValueError(f"Unknown compute provider type: {provider_type}")
