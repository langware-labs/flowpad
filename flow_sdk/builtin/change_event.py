"""ChangeEvent — unified payload for FSOp action handlers.

`_fire` and every TriggerActionHandler.execute receive `list[ChangeEvent]`.
Single-event paths (Test button, restart catch-up replay) pass a 1-element list;
awatch batches pass an N-element list. One fire = one debounce window.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ChangeEvent:
    path: Path
    change_type: str  # "added" | "modified" | "deleted" | "test"
