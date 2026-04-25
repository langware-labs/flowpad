"""Parse a markdown body into a list of WikiLink occurrences.

Recognizes:
  [[name]]               wikilink
  [[name|alias]]         wikilink with display text
  [[name#heading]]       wikilink with heading anchor
  [[name^block]]         wikilink with block anchor
  ![[name]]              embed (transclusion)
  [text](./path.md)      internal markdown link (relative, ends in .md)

Skips fenced code blocks (``` and ~~~) and inline code (`...`).

The `raw` on the returned WikiLink is the full inner text — i.e. everything
between the brackets for wiki forms, or the path for markdown forms.
Alias / heading / block / sub-path are derived from `raw` on read by
callers that need them. This keeps the storage minimal (one TEXT column)
while preserving all information.
"""

import re

from .types import WikiLink


# Wikilinks: `[[...]]` or `![[...]]`. Capture group is the inner text.
# We then post-filter out occurrences inside code regions.
_WIKILINK_RE = re.compile(r"!?\[\[([^\[\]\n]+)\]\]")

# Internal markdown links: `[text](path)` where path is relative and ends
# in `.md` (optionally with a fragment). External http(s) links are excluded.
_MD_LINK_RE = re.compile(
    r"\[(?:[^\[\]\n]+)\]\((?P<path>(?!https?://)[^)\s]+\.md(?:#[^)\s]*)?)\)"
)

# Fenced code blocks (``` or ~~~). DOTALL so the match spans newlines.
_FENCE_RE = re.compile(r"(?ms)^([`~]{3,})[^\n]*\n.*?^\1\s*$")


def _mask_code_regions(body: str) -> str:
    """Replace fenced and inline code with spaces of equal length so that
    line numbers and column offsets are preserved while wikilink/md-link
    regexes can't match inside them."""

    def _spaces(match: re.Match) -> str:
        return " " * (match.end() - match.start())

    # Mask fenced blocks first (multi-line).
    masked = _FENCE_RE.sub(_spaces, body)
    # Then mask inline code spans `...`. Single-line, non-greedy.
    masked = re.sub(r"`[^`\n]+`", _spaces, masked)
    return masked


def _line_of(body: str, offset: int) -> int:
    """1-indexed line number for a character offset in `body`."""
    return body.count("\n", 0, offset) + 1


def parse_links(body: str) -> list[WikiLink]:
    """Extract all wiki/embed/internal-md-link occurrences from `body`.

    Returns a list of WikiLink objects with raw + line populated. src_*/target_*
    are left at their defaults (None) — those are filled by the resolver
    and the indexer respectively.
    """
    if not body:
        return []

    masked = _mask_code_regions(body)
    out: list[WikiLink] = []

    for m in _WIKILINK_RE.finditer(masked):
        out.append(WikiLink(raw=m.group(1), line=_line_of(body, m.start())))

    for m in _MD_LINK_RE.finditer(masked):
        out.append(WikiLink(raw=m.group("path"), line=_line_of(body, m.start())))

    out.sort(key=lambda link: link.line)
    return out
