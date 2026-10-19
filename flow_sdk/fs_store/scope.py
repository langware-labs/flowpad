"""The asset scope vocabulary: ``user``, ``project`` and ``system``.

One enum, defined with placement (``flow_sdk/assets/placement.py``) and re-exported here for the
index. Claude Code's own config locations (managed, local, legacy...) are a different thing:
``flow_sdk/builtin/faas/system_profile_types.py``.
"""

from flow_sdk.assets.placement import Scope

__all__ = ["Scope"]
