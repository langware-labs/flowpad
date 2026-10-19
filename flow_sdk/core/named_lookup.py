"""The two ways a lookup by name fails — nothing has the name, or several things share it.

Each entity that is gettable by name subclasses the pair, so callers catch its own error while
the fields (``name``, ``candidates``) and the "get one by id" sentence stay the same everywhere.
"""
from __future__ import annotations

from typing import ClassVar


class NameNotFound(LookupError):
    """Nothing has that name. ``message`` is the subclass's sentence, formatted with ``name``."""

    message: ClassVar[str] = "nothing named {name!r}"

    def __init__(self, name: str) -> None:
        self.name = name
        super().__init__(self.message.format(name=name))


class NameAmbiguous(LookupError):
    """Several share the name; ``candidates`` are their typeids. ``plural`` names what they are."""

    plural: ClassVar[str] = "entities"

    def __init__(self, name: str, candidates: list[str]) -> None:
        self.name = name
        self.candidates = candidates
        super().__init__(f"{len(candidates)} {self.plural} are named {name!r}; get one by id: {', '.join(candidates)}")
