"""Filling ``{placeholder}`` templates that an asset's manifest carries."""
from __future__ import annotations

from typing import Any, Mapping


class Keep(dict):
    """``format_map`` values: a placeholder nothing fills stays as written."""

    def __missing__(self, key: str) -> str:
        return "{" + key + "}"


def fill(template: str, values: Mapping[str, Any]) -> str:
    """``template`` with every ``{name}`` in ``values`` replaced (as text); the rest left as written."""
    return template.format_map(Keep({k: str(v) for k, v in values.items()}))
