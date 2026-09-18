"""Filesystem contracts independent of application entities."""
from __future__ import annotations

from pathlib import Path


def derive_webapp(data: dict, root: Path, header_raw: dict) -> None:
    from flow_sdk.schema.data_spec.app_location_type import AppLocationType

    data["location_type"] = AppLocationType.Asset
    if not data.get("name"):
        data["name"] = root.name
