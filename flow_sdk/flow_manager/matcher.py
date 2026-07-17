"""The one topic matcher — shared grammar for the whole flow slice.

Grammar: ``seg(.seg)*``, segment charset ``[a-z0-9_-]``, dots strictly
delimiters. Matching is prefix-at-any-depth: pattern ``a.b`` matches ``a.b``
and everything under ``a.b.`` — a strict superset of the capability-kind
segment-1 rule (see ``flow_sdk/core/capabilities/models.py``) and of toplog's
exact matching. Keep this function in sync with its TS mirror
(``ts_sdk/src/services/flow-manager.ts``).
"""
from __future__ import annotations


def topic_matches(pattern: str, topic: str) -> bool:
    """True iff ``topic`` equals ``pattern`` or lives in its subtree."""
    pattern = pattern.strip().lower()
    topic = topic.strip().lower()
    return topic == pattern or topic.startswith(f"{pattern}.")


def topic_ancestors(topic: str) -> list[str]:
    """The ancestor chain of a topic name, root first, self last.

    ``"a.b.c"`` → ``["a", "a.b", "a.b.c"]``. This is the delivery lookup: a
    listener on any ancestor hears the event — O(depth) exact lookups, no
    pattern scans.
    """
    segments = topic.split(".")
    return [".".join(segments[: i + 1]) for i in range(len(segments))]
