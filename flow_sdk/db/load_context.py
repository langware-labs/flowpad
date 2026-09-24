"""Whether entities are being built from stored or received data.

A strict entity type (``Entity._strict_init``) rejects constructor fields it does not
declare, so a caller still passing a removed field fails loudly. Stored and received
data is different: a sqlite row, an asset file or a hub payload may name a field this
build has since dropped, and there an unknown key is history, not a typo. Those reads
run inside ``lenient_entity_load()``.

A leaf module on purpose: the db, serializer and cloud layers all read it, and none of
them may import the entity model to get it.
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import Iterator

_LENIENT_LOAD: ContextVar[bool] = ContextVar("_lenient_entity_load", default=False)


def lenient_load_active() -> bool:
    return _LENIENT_LOAD.get()


@contextmanager
def lenient_entity_load() -> Iterator[None]:
    """Build entities from stored/received data: unknown fields are dropped, not rejected."""
    token = _LENIENT_LOAD.set(True)
    try:
        yield
    finally:
        _LENIENT_LOAD.reset(token)
