"""The shared dot-path ``kind`` ontology used by Artifact and Deployment.

COMPAT SHIM — the grammar now lives in ``flow_sdk/tags/grammar.py`` (one
dot-taxonomy for kinds, bus tags, and capabilities). These names keep their
exact historical behavior (normalize raises on invalid input); new code should
import from ``flow_sdk.tags.grammar`` directly. Kept until the Phase-5
importer migration retires this module.
"""

from __future__ import annotations

from typing import Annotated

from pydantic import BeforeValidator

from flow_sdk.tags.grammar import (
    TAG_PATTERN as KIND_PATTERN,
    normalize_tag,
    tag_ancestors,
    tag_is_within,
)

__all__ = ["KIND_PATTERN", "KindStr", "kind_ancestors", "kind_matches", "normalize_kind"]


def normalize_kind(kind: str) -> str:
    """Normalize and validate an open ontology kind.

    Kinds are deliberately strings rather than an enum: callers may extend the
    vocabulary without an SDK release, while this grammar keeps Python and
    TypeScript matching deterministic.
    """
    try:
        return normalize_tag(kind)
    except ValueError:
        raise ValueError(
            "kind must contain dot-separated lowercase letters, numbers, '_' or '-'"
        ) from None


def kind_matches(query: str, candidate: str) -> bool:
    """Return whether ``candidate`` is ``query`` or one of its descendants."""
    return tag_is_within(normalize_kind(candidate), normalize_kind(query))


def kind_ancestors(kind: str, *, include_self: bool = False) -> list[str]:
    """Return dot ancestors from broadest to narrowest."""
    return tag_ancestors(normalize_kind(kind), include_self=include_self)


#: A pydantic field type for a ``kind`` column: normalized (and rejected when
#: malformed) on input, exactly as ``normalize_kind`` does. One definition for
#: every entity that carries a kind — Artifact, Deployment, MicroApp.
KindStr = Annotated[str, BeforeValidator(normalize_kind)]
