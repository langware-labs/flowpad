"""A shared cursor shape for drivers whose feed has no ``since``.

Lives under ``drivers/`` on purpose: the keys it owns (``high_water`` /
``boundary_ids``) are provider-private cursor state, which nothing outside this
package may read (``test_cursor_state_is_opaque_to_the_subsystem``).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Watermark:
    """A high-water mark for a feed that has no ``since``.

    The mark is the newest stamp seen plus the ids seen AT it — a burst can
    share a second, so a stamp alone cannot say which of its entries are new.
    Walk the feed ascending: ``is_new`` answers, ``advance`` moves the mark,
    ``into`` writes it back to the cursor's state. Kept out of ``state`` by
    the two keys it owns (``high_water`` / ``boundary_ids``); a driver adds
    its own keys beside them.
    """

    high_water: str = ""
    boundary_ids: list[str] = field(default_factory=list)

    @classmethod
    def from_state(cls, state: dict, floor: Optional[str] = None) -> "Watermark":
        """The saved mark, else ``floor`` (a resolved window start) with no ids."""
        high_water = str(state.get("high_water") or floor or "")
        ids = list(state.get("boundary_ids") or []) if state.get("high_water") else []
        return cls(high_water=high_water, boundary_ids=ids)

    def is_new(self, stamp: str, entry_id: str) -> bool:
        """Entries below the mark are old; AT the mark, only unseen ids are new;
        an entry without a stamp is always new (it cannot be placed)."""
        if not (stamp and self.high_water):
            return True
        if stamp < self.high_water:
            return False
        return not (stamp == self.high_water and entry_id in self.boundary_ids)

    def advance(self, stamp: str, entry_id: str) -> None:
        if stamp > self.high_water:
            self.high_water, self.boundary_ids = stamp, [entry_id]
        elif stamp == self.high_water:
            self.boundary_ids.append(entry_id)

    def into(self, state: dict) -> dict:
        if self.high_water:
            state["high_water"] = self.high_water
            state["boundary_ids"] = self.boundary_ids
        return state
