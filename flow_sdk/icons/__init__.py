"""The icon registry — which names exist, and what each one resolves to.

``from flow_sdk.icons import icons`` gets the process-wide registry.
"""

from flow_sdk.icons.registry import IconRegistry, IconResolution, icons

__all__ = ["IconRegistry", "IconResolution", "icons"]
