"""Which ontology a kind belongs to.

A kind minted by us is written bare (``ingest.message.slack``); one minted by an
externally authored asset carries its namespace as a first segment
(``--acme--.ingest.message.slack``). The marker itself belongs to
``flow_sdk/tags/grammar.py`` — ``join_namespace`` / ``split_namespace``, mirrored
in ``ts_sdk/src/tags/grammar.ts`` and pinned by the event contract fixture.

**``--flow--`` is never written.** Ours is the default and it is silent: an
unmarked kind is ours, everywhere.

**The loader declares; this module only remembers.** A kind is minted when a
class body runs, which is during an import — and the loader that started that
import has already read the asset's manifest, so it knows the namespace before
any class exists. It says so with ``loading()``, and the registration hook reads
it back with ``current()``.

The alternative was to DISCOVER the namespace here, by walking up from the
class's own file to find an asset document. That version shipped briefly and is
worth remembering: it put filesystem work in a layer that states it does none,
re-spelled the assets directory, the project root and the manifest's fields that
three other modules already own — and, because it scanned each directory it
passed, it climbed out of the project and parsed whatever JSON sat in the user's
home, credential files included, on every import. A namespace that is DECLARED
cannot have that failure mode; a namespace that is DISCOVERED always can.

Stdlib only, like the rest of ``data_spec``. No I/O.
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import Iterator

from flow_sdk.tags.grammar import join_namespace

#: Ours. Declaring it explicitly is the same as declaring nothing.
FLOW_NS = "flow"

#: The namespace of an asset currently being imported, set by its loader.
_loading: ContextVar[str] = ContextVar("_loading_ns", default="")


@contextmanager
def loading(ns: str) -> Iterator[None]:
    """Import an asset's modules as ``ns``. Every kind they mint is prefixed.

    Scoped to the import rather than stamped onto the classes afterwards,
    because by then the names are already taken: an external declaring the same
    string as a shipped asset would have won the bare name, which is exactly
    what the namespace exists to prevent.
    """
    token = _loading.set(ns or "")
    try:
        yield
    finally:
        _loading.reset(token)


def current() -> str:
    """The namespace being imported right now; ``""`` when it is ours."""
    return _loading.get()


def qualified(kind: str, ns: str = "") -> str:
    """``kind`` in ``ns`` — bare for ours, ``--ns--.``-prefixed for anyone else."""
    return join_namespace("" if ns == FLOW_NS else ns, kind)
