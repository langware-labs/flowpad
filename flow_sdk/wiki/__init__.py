"""Wiki link layer.

Public API is type/id-only — agnostic to whether `Record` or `Entity` calls it.

  - outgoing(type, id)         → list[WikiLink] going out of a source
  - backlinks(type, id)        → list[WikiLink] coming in to a target
  - index(type, id, body)      → re-extract & replace edges for one source
                                 (called by Record.sync_to_db)
"""

from .types import WikiLink
from .indexer import outgoing, backlinks, index

__all__ = ["WikiLink", "outgoing", "backlinks", "index"]
