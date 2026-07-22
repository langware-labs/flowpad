"""Shared dot-taxonomy grammar — THE single owner of topic string rules.

One grammar serves every dot-separated vocabulary in the system: bus topics
(``flow.step.done``), subscription patterns (``flow.*``), and the kind
ontology (``application.web`` — see ``worldview/ontology.py``, now a shim over
this module). TS twin: ``ts_sdk/src/topics/grammar.ts``; parity is pinned by
the ``grammar`` section of ``tests/fixtures/flow_event_contract.json``.

Two match semantics, deliberately named apart and never merged:

* ``topic_matches(pattern, topic)`` — SUBSCRIPTION glob. ``*`` matches exactly
  one segment; a trailing ``*`` matches any remaining suffix.
* ``topic_is_within(topic, prefix)`` — HIERARCHY prefix (exact-or-descendant):
  ``workload`` contains ``workload.service.http``. Lenient (strip+lower, never
  raises) so status/capability matchers can call it on untrusted strings.

Namespaces: a user-world topic starts with a ``--<ns>--`` segment
(``--acme--.orders.created``). The marker is legal ONLY as the first segment.

This module is stdlib-only and imports nothing from flow_sdk — everything
above (bus, ontology, capabilities, entities) imports downward into it.
"""
from __future__ import annotations

import re
from typing import Optional

# Same segment character class as the legacy KIND_PATTERN — existing kinds and
# bus topics all remain valid by construction.
TOPIC_PATTERN = re.compile(r"^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$")

# A namespace marker segment: ``--<ns>--`` with a non-empty simple name.
NAMESPACE_SEGMENT_PATTERN = re.compile(r"^--([a-z0-9_]+)--$")


def normalize_topic(value: str) -> str:
    """Normalize (strip + lower) and validate a topic name. Raises on invalid.

    The STRICT gate — used wherever a topic is adopted as data (entity names,
    kind fields). The bus itself never calls this on emit (bus stays
    permissive; see ``bus.py``).
    """
    if not isinstance(value, str):
        raise TypeError("topic must be a string")
    normalized = value.strip().lower()
    if not TOPIC_PATTERN.fullmatch(normalized):
        raise ValueError(
            "topic must contain dot-separated lowercase letters, numbers, '_' or '-'"
        )
    for i, seg in enumerate(normalized.split(".")):
        if NAMESPACE_SEGMENT_PATTERN.fullmatch(seg) and i != 0:
            raise ValueError("a --namespace-- marker is only legal as the first segment")
    return normalized


def is_valid_topic(value: object) -> bool:
    """True when ``value`` normalizes into a valid topic name."""
    if not isinstance(value, str):
        return False
    try:
        normalize_topic(value)
    except (TypeError, ValueError):
        return False
    return True


def topic_segments(topic: str) -> list[str]:
    return topic.split(".")


def split_namespace(topic: str) -> tuple[Optional[str], str]:
    """Split ``--acme--.orders.created`` → ``("acme", "orders.created")``.

    System topics (no marker) return ``(None, topic)`` unchanged.
    """
    head, _, rest = topic.partition(".")
    m = NAMESPACE_SEGMENT_PATTERN.fullmatch(head)
    if m:
        return m.group(1), rest
    return None, topic


def topic_ancestors(topic: str, *, include_self: bool = False) -> list[str]:
    """Dot ancestors from broadest to narrowest (strict — normalizes first)."""
    normalized = normalize_topic(topic)
    parts = normalized.split(".")
    stop = len(parts) + 1 if include_self else len(parts)
    return [".".join(parts[:index]) for index in range(1, stop)]


# ── subscription glob (the bus semantics) ────────────────────────────────────

def segments_match(p: list[str], t: list[str]) -> bool:
    """Segment-wise glob core over pre-split lists (hot path — no allocation)."""
    for i, seg in enumerate(p):
        if seg == "*" and i == len(p) - 1:
            return len(t) >= i + 1
        if i >= len(t):
            return False
        if seg != "*" and seg != t[i]:
            return False
    return len(t) == len(p)


def topic_matches(pattern: str, topic: str) -> bool:
    """Segment-wise glob over the dot path. ``*`` matches exactly one segment;
    a TRAILING ``*`` matches any remaining suffix (``app.*`` matches
    ``app.route.loaded``). No partial-segment matching."""
    if pattern == "*":
        return True
    return segments_match(pattern.split("."), topic.split("."))


def topic_pattern_problem(pattern: "str | None") -> Optional[str]:
    """THE pattern grammar gate (TOPIC triggers, flow subscriptions): a pointed
    problem string, or None when valid. Segments must be topic segments or
    ``*``; a bare ``*`` is rejected (it would fire on every event)."""
    stripped = (pattern or "").strip()
    if not stripped:
        return "a non-empty topic pattern is required"
    if stripped == "*":
        return ('pattern "*" would fire on EVERY event in the system — '
                'subscribe to a family (e.g. "entity.*", "flow.*") instead')
    for i, seg in enumerate(stripped.split(".")):
        if seg == "*":
            continue
        if not TOPIC_PATTERN.fullmatch(seg):
            return (f'segment "{seg}" is not a valid topic segment '
                    "(lowercase letters, numbers, '_', '-', or '*')")
        if NAMESPACE_SEGMENT_PATTERN.fullmatch(seg) and i != 0:
            return "a --namespace-- marker is only legal as the first segment"
    return None


def is_valid_topic_pattern(pattern: "str | None") -> bool:
    return topic_pattern_problem(pattern) is None


# ── hierarchy prefix (the ontology semantics) ────────────────────────────────

def topic_is_within(topic: str, prefix: str) -> bool:
    """Exact-or-descendant containment: ``workload`` contains
    ``workload.service.http``. LENIENT — strip+lower without grammar
    validation, never raises (capability resolution calls this on
    config-supplied strings)."""
    t = topic.strip().lower()
    p = prefix.strip().lower()
    return t == p or t.startswith(f"{p}.")


def topic_tree(names: list[str]) -> dict[str, list[str]]:
    """Derive the parent → children adjacency implied by dot-paths. Includes
    implicit intermediate nodes; roots appear under the ``""`` key. Pure
    derivation — the taxonomy graph is never stored."""
    children: dict[str, set[str]] = {}
    for name in names:
        parts = name.split(".")
        for i in range(len(parts)):
            parent = ".".join(parts[:i])
            child = ".".join(parts[: i + 1])
            children.setdefault(parent, set()).add(child)
    return {parent: sorted(kids) for parent, kids in children.items()}
