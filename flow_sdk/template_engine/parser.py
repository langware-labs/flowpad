"""Extract template references from Handlebars content."""

import re
from typing import List


def extract_template_refs(content: str) -> List[str]:
    """
    Extract template/variable references from Handlebars template content.

    Returns deduplicated list preserving first-occurrence order.
    Matches:
      - ``{{variable}}`` (not ``#``, ``/``, ``!`` prefixed)
      - ``{{#if|unless|each|with variable}}``
      - ``{{{variable}}}``
    """
    if not isinstance(content, str):
        return []

    refs: List[str] = []
    seen: set[str] = set()

    def _add(name: str) -> None:
        if name not in seen:
            refs.append(name)
            seen.add(name)

    # Pattern 1: simple variables {{variable}} — skip helpers (#, /, !)
    for m in re.findall(
        r"\{\{\s*(?![#/!])([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_\[\]]*)*)\s*\}\}",
        content,
    ):
        _add(m)

    # Pattern 2: block helpers {{#if|unless|each|with variable}}
    for m in re.findall(
        r"\{\{\s*#(?:if|unless|each|with)\s+([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_\[\]]*)*)\s*\}\}",
        content,
    ):
        _add(m)

    # Pattern 3: triple-brace {{{variable}}}
    for m in re.findall(
        r"\{\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_\[\]]*)*)\s*\}\}\}",
        content,
    ):
        _add(m)

    return refs
