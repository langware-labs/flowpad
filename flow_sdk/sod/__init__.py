"""Secure Object Database (SOD) module.

Provides abstract SodDriver interface and concrete implementations for
storing and retrieving sensitive data (API keys, OAuth tokens, etc.).
"""

from .sod_provider_base import SodDriver
from .file_sod import FileSodStorage
from .gcp_sod import GCSISod
from .sod_utils import get_sod_driver

__all__ = [
    "SodDriver",
    "FileSodStorage",
    "GCSISod",
    "get_sod_driver",
]
