"""Filesystem contracts independent of application entities."""
from __future__ import annotations

from pathlib import Path


def derive_spec(data: dict, root: Path, header_raw: dict) -> None:
    """The name is the title, else the folder — a fact of the path, not the header."""
    data["name"] = data.get("title") or root.name
    data.setdefault("title", data["name"])
