"""The one fact about a webapp asset that its manifest cannot state.

``webapp.json`` describes the app — name, kind, which subdir is the build. It
deliberately does NOT say where the app lives: that is a fact of having been
found there, and an absolute machine path in a shipped file would be wrong on
every other machine. So the loader supplies ``location_type`` instead, and the
generic FS→entity seam (``FSRecord.meta_dict`` → ``Entity.from_record``) stamps
``asset_ref`` from the ref the walker emitted, exactly as it does for every
other repo asset.
"""

from __future__ import annotations

from pathlib import Path


def derive_webapp(data: dict, root: Path, header_raw: dict) -> None:
    from flow_sdk.builtin.faas.micro_app import AppLocationType  # noqa: PLC0415

    data["location_type"] = AppLocationType.Asset
    if not data.get("name"):
        data["name"] = root.name
