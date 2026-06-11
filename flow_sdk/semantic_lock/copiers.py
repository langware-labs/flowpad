"""Copiers — deterministic transforms for ``kind=copy`` adjudication.

A copy-kind edge asserts: ``target bytes == copier(lock bytes)``. Copiers
must be deterministic AND idempotent (``copier(copier(x)) == copier(x)``,
test-enforced) so copy cycles converge and re-checks are stable. No LLM ever
touches a copy edge.

The registry is keyed ``(source_kind, target_kind)`` where a kind is an
``EntityType`` value or a file extension (".md"); ``("*", "*")`` is the
``full_copy`` default. One copier rule per target (the one-writer rule) is
validated at relationship save, not here.
"""

from __future__ import annotations

from typing import Callable

from flow_sdk.llm_index.core import sha256_bytes
from flow_sdk.llm_index.markdown_document import MarkdownDocument

Copier = Callable[[bytes], bytes]

# Frontmatter keys that must never survive a copy: an id/type carried into
# the target would be a foreign-id adoption hazard at the receiving entity.
_IDENTITY_KEYS = ("id", "type")


def full_copy(data: bytes) -> bytes:
    """Identity transform — the default copier."""
    return data


def markdown_strip_frontmatter_ids(data: bytes) -> bytes:
    """Copy markdown, dropping identity frontmatter keys (the claude.md →
    agents.md case): parse → drop ``id``/``type`` → deterministic re-render."""
    doc = MarkdownDocument.from_text(data.decode("utf-8", "replace"))
    for key in _IDENTITY_KEYS:
        doc.frontmatter.pop(key, None)
    return doc.render().encode("utf-8")


_REGISTRY: dict[tuple[str, str], Copier] = {
    ("*", "*"): full_copy,
    (".md", ".md"): markdown_strip_frontmatter_ids,
    ("markdown", "markdown"): markdown_strip_frontmatter_ids,
}


def register_copier(source_kind: str, target_kind: str, copier: Copier) -> None:
    _REGISTRY[(source_kind, target_kind)] = copier


def copier_for(source_kind: str, target_kind: str) -> Copier:
    """Most specific registered copier: exact pair → source wildcard →
    target wildcard → full_copy."""
    for key in ((source_kind, target_kind), (source_kind, "*"), ("*", target_kind)):
        if key in _REGISTRY:
            return _REGISTRY[key]
    return _REGISTRY[("*", "*")]


def adjudicate_copy(source: bytes, target: bytes, copier: Copier) -> bool:
    """True iff the target equals the copier transform of the source."""
    return sha256_bytes(copier(source)) == sha256_bytes(target)
