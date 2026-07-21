"""The shared dot-path ``kind`` ontology used by Artifact and Deployment."""

from __future__ import annotations

import re

KIND_PATTERN = re.compile(r"^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$")


def normalize_kind(kind: str) -> str:
    """Normalize and validate an open ontology kind.

    Kinds are deliberately strings rather than an enum: callers may extend the
    vocabulary without an SDK release, while this grammar keeps Python and
    TypeScript matching deterministic.
    """

    if not isinstance(kind, str):
        raise TypeError("kind must be a string")
    normalized = kind.strip().lower()
    if not KIND_PATTERN.fullmatch(normalized):
        raise ValueError("kind must contain dot-separated lowercase letters, numbers, '_' or '-'")
    return normalized


def kind_matches(query: str, candidate: str) -> bool:
    """Return whether ``candidate`` is ``query`` or one of its descendants."""

    normalized_query = normalize_kind(query)
    normalized_candidate = normalize_kind(candidate)
    return normalized_candidate == normalized_query or normalized_candidate.startswith(f"{normalized_query}.")


def kind_ancestors(kind: str, *, include_self: bool = False) -> list[str]:
    """Return dot ancestors from broadest to narrowest."""

    normalized = normalize_kind(kind)
    parts = normalized.split(".")
    stop = len(parts) + 1 if include_self else len(parts)
    return [".".join(parts[:index]) for index in range(1, stop)]


__all__ = ["KIND_PATTERN", "kind_ancestors", "kind_matches", "normalize_kind"]
