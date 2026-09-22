"""Filesystem contracts independent of application entities."""

from __future__ import annotations

from pathlib import Path


def derive_webapp(data: dict, root: Path, header_raw: dict) -> None:
    if not data.get("name"):
        data["name"] = root.name

