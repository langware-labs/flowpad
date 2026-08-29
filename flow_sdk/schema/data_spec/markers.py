"""Field-type markers — the two facts a spec states about its main document.

A ``DataSpec`` describes an on-disk tree through its field TYPES: ``FileRef``
is a file, ``FolderSpec`` a directory, a nested entity a sub-asset. Two facts
have no leaf type of their own, because they are about the MAIN document:
which ``str`` is the markdown body, and which ``dict`` is the free ``data``
section of a two-section JSON manifest. They are ``Annotated`` markers, so the
field keeps its plain Python type everywhere else (the DB row, the API) and
only the disk serializer reads the annotation.

At most one of each per spec (``fields.spec_layout`` enforces it).
"""

from __future__ import annotations

import types
from dataclasses import dataclass
from typing import Annotated, Any, Optional, Union, get_args, get_origin


@dataclass(frozen=True)
class BodyMarker:
    """This ``str`` is the markdown body of the main document."""


@dataclass(frozen=True)
class FreeSectionMarker:
    """This ``dict`` is the free ``data`` section of a two-section JSON manifest."""


#: The markdown body — rendered after the frontmatter, never in it.
Body = Annotated[str, BodyMarker()]
#: The free JSON section — ``{"metadata": <header>, "data": <this>}``.
FreeSection = Annotated[dict[str, Any], FreeSectionMarker()]


def marker_of(annotation: Any) -> Optional[BodyMarker | FreeSectionMarker]:
    """The marker on ``annotation``, looking through ``Optional`` / ``Union``
    and ``Annotated`` layers; None when the field carries none."""
    origin = get_origin(annotation)
    if origin is Annotated:
        for meta in get_args(annotation)[1:]:
            if isinstance(meta, (BodyMarker, FreeSectionMarker)):
                return meta
        return marker_of(get_args(annotation)[0])
    if origin in (Union, types.UnionType):
        for arg in get_args(annotation):
            if arg is not type(None):
                found = marker_of(arg)
                if found is not None:
                    return found
    return None
