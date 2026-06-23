"""View-mode visibility tiers — the backend mirror of the frontend enum.

A type's ``browseable_by`` says the *minimum* view mode at which it appears in
the Assets browser. Visibility is **cumulative**: a higher mode sees everything
a lower mode sees (``Standard ⊂ Advanced ⊂ Dev``). ``None`` ⇒ never browseable.

The string values MUST stay byte-identical to the frontend enum in
``ui/src/contexts/view-mode-context.tsx`` — they ride the bootstrap payload and
are compared directly on the client.
"""
from __future__ import annotations

from flow_sdk._compat import StrEnum


class ViewMode(StrEnum):
    STANDARD = "standard"
    ADVANCED = "advanced"
    DEV = "dev"


# Visibility ordering: a type required at level L is visible when the current
# mode's rank is >= L's rank.
_ORDER: dict[ViewMode, int] = {
    ViewMode.STANDARD: 0,
    ViewMode.ADVANCED: 1,
    ViewMode.DEV: 2,
}


def view_mode_rank(mode: ViewMode) -> int:
    return _ORDER[mode]


def visible_in(required: ViewMode | None, current: ViewMode) -> bool:
    """True iff a type whose ``browseable_by`` is ``required`` shows in ``current``."""
    return required is not None and _ORDER[current] >= _ORDER[required]
