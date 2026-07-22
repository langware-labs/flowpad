"""The shared dot-path ``kind`` ontology used by Artifact and Deployment.

COMPAT SHIM — the grammar now lives in ``flow_sdk/topics/grammar.py`` (one
dot-taxonomy for kinds, bus topics, and capabilities). These names keep their
exact historical behavior (normalize raises on invalid input); new code should
import from ``flow_sdk.topics.grammar`` directly. Kept until the Phase-5
importer migration retires this module.
"""

from __future__ import annotations

from flow_sdk.topics.grammar import (
    TOPIC_PATTERN as KIND_PATTERN,
    normalize_topic,
    topic_ancestors,
    topic_is_within,
)

__all__ = ["KIND_PATTERN", "kind_ancestors", "kind_matches", "normalize_kind"]


def normalize_kind(kind: str) -> str:
    """Normalize and validate an open ontology kind.

    Kinds are deliberately strings rather than an enum: callers may extend the
    vocabulary without an SDK release, while this grammar keeps Python and
    TypeScript matching deterministic.
    """
    try:
        return normalize_topic(kind)
    except ValueError:
        raise ValueError(
            "kind must contain dot-separated lowercase letters, numbers, '_' or '-'"
        ) from None


def kind_matches(query: str, candidate: str) -> bool:
    """Return whether ``candidate`` is ``query`` or one of its descendants."""
    return topic_is_within(normalize_kind(candidate), normalize_kind(query))


def kind_ancestors(kind: str, *, include_self: bool = False) -> list[str]:
    """Return dot ancestors from broadest to narrowest."""
    return topic_ancestors(normalize_kind(kind), include_self=include_self)
