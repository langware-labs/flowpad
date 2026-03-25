from flow_sdk.config import ServiceConfig, SodProvider
from flow_sdk.external_apis.sod.providers.file_sod import FileSodStorage
from flow_sdk.external_apis.sod.providers.gcp_sod import GCSISod

from .providers.sod_provider_base import SodDriver

available_sod_drivers = [provider.value for provider in SodProvider]


def get_sod_driver(cfg: ServiceConfig, provider: str | None = None) -> SodDriver:
    if provider is None:
        provider = cfg.sod_provider
    if provider == "file":
        provider = SodProvider.DEV_FILE.value
    if provider not in available_sod_drivers:
        raise ValueError(f"Invalid sod_driver: {provider}")
    if provider == SodProvider.GCP.value:
        driver = GCSISod(cfg)
    elif provider == SodProvider.DEV_FILE.value:
        driver = FileSodStorage(cfg)
    else:
        raise ValueError(f"Invalid sod_driver: {cfg.sod_provider}")
    return driver
