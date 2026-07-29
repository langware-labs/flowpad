"""Parse a markdown body into a list of WikiLink occurrences.

Recognizes:
  [[name]]                          wikilink
  [[name|alias]]                    wikilink with display text
  [[name#heading]]                  wikilink with heading anchor
  [[name^block]]                    wikilink with block anchor
  ![[name]]                         embed (transclusion)
  [text](./path.md)                 internal markdown link (relative, ends in .md)
  [text](/dock/assets/wiki/<name>)  wiki dock-route link (emitted by the
                                    UI's "Add entity link" toolbar). The
                                    name segment is decoded as `raw`.

Skips fenced code blocks (``` and ~~~) and inline code (`...`).

The `raw` on the returned WikiLink is the full inner text — i.e. everything
between the brackets for wiki forms, or the path / decoded name for
markdown forms. Alias / heading / block / sub-path are derived from `raw`
on read by callers that need them. This keeps the storage minimal (one
TEXT column) while preserving all information.
"""

import re
from urllib.parse import unquote

from .types import WikiLink

# Wikilinks: `[[...]]` or `![[...]]`. Capture group is the inner text.
# We then post-filter out occurrences inside code regions.
_WIKILINK_RE = re.compile(r"!?\[\[([^\[\]\n]+)\]\]")

# Internal markdown links: `[text](path)` where path is relative and ends
# in `.md` (optionally with a fragment). External http(s) links are excluded.
_MD_LINK_RE = re.compile(
    r"\[(?:[^\[\]\n]+)\]\((?P<path>(?!https?://)[^)\s]+\.md(?:#[^)\s]*)?)\)"
)

# Wiki dock-route links:
#   legacy local: [text](/dock/assets/wiki/<word>)
#   canonical:    [text](/dock/assets/wiki/<wiki-ref>/<word>)
#   Hub:          [text](/dock/hub/assets/wiki/<wiki-ref>/<word>)
_WIKI_URL_RE = re.compile(
    r"\[(?:[^\[\]\n]+)\]\(/dock/(?P<hub>hub/)?assets/wiki/(?P<path>[^)\s#]+)(?:#[^)\s]*)?\)"
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


def canonicalize_word(raw: str) -> str:
    """Return the existing record-name form used by Wiki resolution.

    This deliberately preserves case and Unicode. It strips only the link
    decorations already supported by the parser/resolver.
    """
    if not isinstance(raw, str):
        raise ValueError("Wiki word must be a string")
    value = raw.strip().split("|", 1)[0].split("#", 1)[0].split("^", 1)[0]
    if value.endswith(".md"):
        value = value[:-3]
    parts = [part for part in value.split("/") if part and part not in (".", "..")]
    canonical = parts[0] if parts else value.strip()
    if not canonical:
        raise ValueError("Wiki word must not be empty")
    return canonical


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

    for m in _WIKI_URL_RE.finditer(masked):
        encoded_path = m.group("path")
        segments = encoded_path.split("/", 1)
        is_canonical = bool(m.group("hub")) or len(segments) == 2
        if is_canonical:
            wiki_ref = unquote(segments[0])
            raw = unquote(segments[1]) if len(segments) == 2 else ""
        else:
            wiki_ref = None
            raw = unquote(encoded_path)
        out.append(
            WikiLink(
                raw=raw,
                line=_line_of(body, m.start()),
                wiki_ref=wiki_ref,
            )
        )

    for m in _MD_LINK_RE.finditer(masked):
        # Skip if this match was already captured as a wiki URL above —
        # _WIKI_URL_RE is a stricter subset; avoid double-emitting.
        if "/dock/assets/wiki/" in m.group("path"):
            continue
        out.append(WikiLink(raw=m.group("path"), line=_line_of(body, m.start())))

    out.sort(key=lambda link: link.line)
    return out
