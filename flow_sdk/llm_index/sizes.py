"""The canonical size tiers for LLM-facing document summaries.

LLMIndex has always had three SEMANTIC tiers — the one-line ``FileRef.summary``,
the ≤60-word ``self_summary``, and the full document — but the numbers lived in
comments. This module is their single home; consumers (``flow topic get``,
future context bundlers) import these instead of inventing budgets.

``resolve_doc_summaries`` maps a markdown document onto the line/block tiers
WITHOUT any LLM call, via a fallback chain:

1. an LLMIndex ``.summary.md`` cache entry for the file's content hash, when a
   summaries dir is supplied (the ``markdown_index`` skill maintains these);
2. the frontmatter ``description`` / ``summary`` field;
3. the H1 title + first body paragraph.

Whatever the source, output is truncated to the tier budgets.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Optional

from .markdown_document import parse_frontmatter

# Tier budgets. LINE is a terminal-friendly single line; BLOCK promotes the
# long-standing "≤60 words" self_summary bound from docstring to constant;
# FULL_MAX_BYTES guards whole-document returns (mirrors diff.MAX_DIFF_BYTES's
# order of magnitude, but for prompt payloads).
LINE_MAX_CHARS = 160
BLOCK_MAX_WORDS = 60
FULL_MAX_BYTES = 200_000

_H1_RE = re.compile(r"^#\s+(.+?)\s*$", re.MULTILINE)


def clip_line(text: str, limit: int = LINE_MAX_CHARS) -> str:
    line = " ".join(text.split())
    return line if len(line) <= limit else line[: limit - 1].rstrip() + "…"


def clip_block(text: str, limit: int = BLOCK_MAX_WORDS) -> str:
    words = text.split()
    return " ".join(words) if len(words) <= limit else " ".join(words[:limit]) + " …"


def _first_paragraph(body: str) -> str:
    for chunk in re.split(r"\n\s*\n", body):
        stripped = chunk.strip()
        # Skip headings/fences — we want prose.
        if stripped and not stripped.startswith(("#", "```", "~~~", "<!--")):
            return stripped
    return ""


def resolve_doc_summaries(
    path: Path | str,
    body: str,
    *,
    summaries_dir: Optional[Path] = None,
    content_hash: Optional[str] = None,
) -> tuple[str, str]:
    """Return ``(line, block)`` summaries for a markdown document.

    Pure and LLM-free: cached LLMIndex summary → frontmatter description →
    title + first paragraph. Always truncated to the tier budgets.
    """
    # 1. LLMIndex summary cache (content-addressed, written by markdown_index).
    if summaries_dir is not None and content_hash:
        cached = Path(summaries_dir) / f"{content_hash}.summary.md"
        try:
            text = cached.read_text(encoding="utf-8").strip()
        except OSError:
            text = ""
        if text:
            return clip_line(text), clip_block(text)

    frontmatter, md_body = parse_frontmatter(body)

    # 2. Frontmatter description/summary.
    described = frontmatter.get("description") or frontmatter.get("summary")
    if isinstance(described, str) and described.strip():
        return clip_line(described), clip_block(described)

    # 3. Title + first paragraph.
    h1 = _H1_RE.search(md_body)
    title = h1.group(1).strip() if h1 else Path(path).stem
    paragraph = _first_paragraph(md_body)
    combined = f"{title} — {paragraph}" if paragraph else title
    return clip_line(combined), clip_block(combined)
