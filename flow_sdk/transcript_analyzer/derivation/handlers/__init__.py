"""One handler per file, one rule per handler.

Adding a semantic entry kind is a new module here plus a line in
:func:`install_all` — never an edit to a parser. That is the whole point of the
layer: a kind that exists for one worker exists for all of them, and a gap shows
up as a missing registration rather than as silence.
"""

from __future__ import annotations

from . import artifact, flow_command, tool_semantics


def install_all() -> None:
    """Register every handler. Idempotent — safe to call more than once.

    Order matters only in that a handler must be registered before the entries
    it consumes are derived; the worklist itself is order-independent because it
    re-feeds generated entries until nothing new appears.
    """
    # Order is presentational only — the worklist re-feeds generated entries, so
    # a handler registered later still refines an earlier one's output.
    tool_semantics.install()
    flow_command.install()
    artifact.install()
