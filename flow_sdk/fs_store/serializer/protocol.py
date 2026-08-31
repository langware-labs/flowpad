"""``DataSerializer`` — HOW and WHERE an object is persisted.

What we save has nothing to do with how we save it. A class declares WHAT:
its fields, which one is the body, that a field is a file or a folder. A
serializer maps those declared types onto one medium — disk, the entity
table, the hub — and the one that cannot honor a declaration raises rather
than downgrade it. ``store``/``load`` take an ``FSOrigin``: WHERE is resolved
from ``origin.kind`` through a registry, the same way ``FSOriginDriver`` is.
"""

from __future__ import annotations

from typing import Any, Optional, Protocol, runtime_checkable

from flow_sdk.fs_store.origin.fs_origin import FSOrigin


class UnsupportedFieldError(ValueError):
    """A field's declared persistence (a file, a folder, a sub-asset) cannot be
    honored by this serializer. Raised, never downgraded."""


@runtime_checkable
class DataSerializer(Protocol):
    #: The ``FSOrigin.kind`` this serializer serves.
    kind: str

    def store(self, obj: Any, origin: FSOrigin) -> FSOrigin:
        """Persist ``obj`` at ``origin``. Returns the origin with ``id`` set to
        the COMMITTED entity id — the carrier is authoritative and may differ
        from the id proposed."""
        ...

    def load(self, cls: type, origin: FSOrigin, *, entity_id: Optional[str] = None) -> Any:
        """Reconstitute a ``cls`` from ``origin``."""
        ...
