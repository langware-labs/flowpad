"""``listen(*sources)`` / ``pages(*sources)`` — one loop over several sources, each delivery
still carrying ITS ack.

The merge itself is ``flow_sdk.utils.aiter_merge.merge_iterators``; what this module fixes is
that a merge must not erase which source a delivery came from — the ack IS the source. Each
``Delivered`` (or ``DeliveredPage``) keeps its own position, so acking one never touches another
source's. One source erroring is loud: ``sync`` never raises, so an exception out of a source's
loop is a bug or a driver refusing, and the merge cancels its siblings and re-raises it.
"""

from __future__ import annotations

from typing import Any, AsyncIterator

from flow_sdk.blocks.delivery import Delivered, DeliveredPage
from flow_sdk.utils.aiter_merge import merge_iterators


def listen(*sources: Any, poll_every: "float | None" = None) -> AsyncIterator[Delivered]:
    """Yield from every source's ``listen()`` as items arrive, in arrival order."""
    return merge_iterators([s.listen(poll_every=poll_every) for s in sources])


def pages(
    *sources: Any, size: int = 50, poll_every: "float | None" = None, poll: bool = True
) -> AsyncIterator[DeliveredPage]:
    """Yield from every source's ``pages()`` as pages land; one page is always one source's."""
    return merge_iterators([s.pages(size=size, poll_every=poll_every, poll=poll) for s in sources])


__all__ = ["listen", "pages"]
