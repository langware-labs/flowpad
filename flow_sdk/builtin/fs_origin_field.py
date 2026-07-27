"""``FSOriginField`` — the discriminated-union type for storing an FSOrigin.

Entity fields and bundle payloads that accept ANY origin backend must be typed
as ``FSOriginField`` (not bare ``FSOrigin``), so pydantic reconstructs the right
subclass — ``GitOrigin`` / ``LocalOrigin`` — with its locator fields intact. A
bare-``FSOrigin`` field would instantiate the base and silently drop those.

The discriminator is a callable so a LEGACY origin dict (persisted before the
``kind`` discriminant existed) with no ``kind`` key resolves to ``git`` instead
of raising — the cross-version tolerant read.
"""
from __future__ import annotations

from typing import Annotated, Union

from pydantic import Discriminator, Tag, TypeAdapter

from flow_sdk.builtin.fs_origin import resolve_origin_kind
from flow_sdk.builtin.git_origin import GitOrigin
from flow_sdk.builtin.local_origin import LocalOrigin

FSOriginField = Annotated[
    Union[
        Annotated[GitOrigin, Tag("git")],
        Annotated[LocalOrigin, Tag("local")],
    ],
    # Callable discriminator so a legacy dict with no ``kind`` resolves to git
    # (the shared rule in ``resolve_origin_kind``) instead of raising.
    Discriminator(resolve_origin_kind),
]

# Cache the adapter — TypeAdapter compiles a full validation schema for the
# union; rebuilding it per call (e.g. once per bundle entry on unpack) is the
# expensive part pydantic warns about. Reuse this everywhere.
FS_ORIGIN_ADAPTER: TypeAdapter = TypeAdapter(FSOriginField)
