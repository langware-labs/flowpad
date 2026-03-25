"""SOD driver factory and utilities."""

from typing import Optional

from flow_sdk.config import ServiceConfig, SodProvider
from .sod_provider_base import SodDriver
from .file_sod import FileSodStorage
from .gcp_sod import GCSISod

# List of available SOD driver types
available_sod_drivers = [provider.value for provider in SodProvider]


def get_sod_driver(cfg: ServiceConfig, provider: Optional[str] = None) -> SodDriver:
    """Factory function to get SOD driver instance.

    Args:
        cfg: ServiceConfig with SOD settings.
        provider: SOD provider type. Uses cfg.sod_provider if not specified.

    Returns:
        Initialized SodDriver instance.

    Raises:
        ValueError: If provider is invalid or configuration is missing.
    """
    if provider is None:
        provider = cfg.sod_provider

    # Alias "file" to "dev_file" for backward compatibility
    if provider == "file":
        provider = SodProvider.DEV_FILE.value

    if provider not in available_sod_drivers:
        raise ValueError(f"Invalid sod_provider: {provider}")

    if provider == SodProvider.GCP.value:
        driver = GCSISod(cfg)
    elif provider == SodProvider.DEV_FILE.value:
        driver = FileSodStorage(cfg)
    else:
        raise ValueError(f"Invalid sod_driver: {provider}")

    return driver
