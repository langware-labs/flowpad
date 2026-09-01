"""``DbOrigin`` / ``HubOrigin`` — locators for the non-disk serializers.

An ``FSOrigin`` is a backend-tagged pointer; these two say "the entity table"
and "the hub" so ``store(obj, origin)`` resolves WHERE from ``origin.kind``
uniformly. They never leave the process and carry no coordinates beyond the
row/URL key, which is the entity id (``FSOrigin.id``).
"""

from __future__ import annotations

from typing import Literal

from flow_sdk.fs_store.origin.fs_origin import FSOrigin


class DbOrigin(FSOrigin):
    kind: Literal["db"] = "db"

    @property
    def transportable(self) -> bool:
        return False


class HubOrigin(FSOrigin):
    kind: Literal["hub"] = "hub"
