"""The request shape for ``POST /api/v1/shell/belonging-to`` (``Shell.belonging_to``).

Shapes live in the packages ``test_the_two_classification_tables`` imports, not under
``flow_sdk.server`` — the route imports this one.
"""

from __future__ import annotations

from typing import Optional

from flow_sdk.schema.data_spec.spec import DataSpec


class ShellBelongingToRequest(DataSpec):
    """What the terminal belongs to, and where a new one starts."""

    what: str
    workdir: Optional[str] = None
    name: Optional[str] = None
