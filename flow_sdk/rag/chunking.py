"""Cut a markdown document into retrievable chunks.

Headings are the seam. A markdown document already carries the structure a reader uses to
find things, so splitting on it gives chunks that are about one topic and that can say where
they came from — which is what makes a citation useful rather than a page reference.

Three rules, in order:

1. **Split on headings.** Every heading opens a section, and a section knows its ancestor
   headings, so a chunk can be cited as "Auth › Tokens › Refresh" rather than "line 412".
2. **Fold the runts.** A heading with two sentences under it retrieves badly on its own and
   costs an embedding; below ``min_tokens`` it joins the section before it.
3. **Split the giants.** Above ``max_tokens`` a section is cut on paragraph boundaries, with
   the tail of each piece repeated at the head of the next so a sentence spanning the cut is
   still findable from either side.

Deliberately not semantic chunking. That needs a model call per document and buys little on
prose that is already sectioned by a human; the heading structure is free and better.

Pure: no I/O, no entity, no network. Everything here is a function of the text.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from flow_sdk.schema.data_spec.rag_spec import RagChunk

#: An ATX heading: one to six hashes, a space, then the title.
_HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
#: A fenced block delimiter: three or more backticks or tildes, with an optional info string.
#:
#: There is a second fence authority in Python, ``flow_sdk/wiki/parser.py::_FENCE_RE``, and the
#: two agree on the rule below. They are not shared because the shapes differ: that one is a
#: whole-document regex matching a complete block in order to BLANK it, and this one is a
#: line-by-line state machine that must keep the fenced text in its output. If the rule ever
#: changes, change both.
#: Anything inside is literal text — a ``# comment`` in a Python fence is not a heading, and
#: treating it as one splits a code sample down the middle.
#:
#: The character and the run length are both captured because CommonMark closes a fence only
#: with the SAME character and at least as many of it. A plain toggle got this wrong twice: a
#: ```` ```` ```` block quoting a ``` ``` ``` block — how every document that shows markdown is
#: written — closed early, and a ``~~~`` line closed a backtick fence.
_FENCE = re.compile(r"^\s{0,3}(`{3,}|~{3,})\s*(\S*)")

#: Chunking defaults. Tokens, measured with the same encoder the embedding models use.
MAX_TOKENS = 512
MIN_TOKENS = 64
OVERLAP_TOKENS = 64


@dataclass(slots=True)
class Section:
    """A heading and the body beneath it, before any size rules are applied.

    Mutable, because the fold rewrites ``text`` in place when a runt joins its neighbour.
    """

    heading_path: list[str]
    text: str


@dataclass(frozen=True, slots=True)
class _Para:
    """A paragraph and its token count, measured once. See ``_split_oversized``."""

    text: str
    tokens: int


def _count(text: str) -> int:
    """Tokens in one string."""
    from flow_sdk.utils.text import sync_count_tokens  # noqa: PLC0415

    return sync_count_tokens(text)


def _count_all(texts: list[str]) -> list[int]:
    """Tokens for each of many strings, in one batch.

    Not ``sync_count_tokens``: that answers the SUM across a list, and this needs the counts
    itemized so a section's size and a piece's size are both derivable without re-measuring.
    """
    import tiktoken  # noqa: PLC0415

    if not texts:
        return []
    return [len(e) for e in tiktoken.get_encoding("cl100k_base").encode_batch(texts)]


def split_sections(body: str) -> list[Section]:
    """The document's headings and their bodies, in order.

    Text before the first heading is a section with an empty path — a document may open with
    a paragraph, and dropping it would lose the summary that is often the best answer.
    """
    sections: list[Section] = []
    stack: list[tuple[int, str]] = []
    path: list[str] = []
    lines: list[str] = []
    #: The open fence's delimiter, or "" outside a fence.
    fence = ""

    def flush() -> None:
        text = "\n".join(lines).strip()
        if text:
            sections.append(Section(list(path), text))
        lines.clear()

    for line in body.splitlines():
        delimiter = _FENCE.match(line)
        if delimiter is not None:
            run, info = delimiter.group(1), delimiter.group(2)
            if not fence:
                fence = run
            elif run[0] == fence[0] and len(run) >= len(fence) and not info:
                fence = ""  # a closing fence carries no info string
            lines.append(line)
            continue
        match = None if fence else _HEADING.match(line)
        if match is None:
            lines.append(line)
            continue
        flush()
        level, title = len(match.group(1)), match.group(2).strip()
        while stack and stack[-1][0] >= level:
            stack.pop()
        stack.append((level, title))
        path = [t for _, t in stack]
        # The heading line itself opens the new section's text: it is the most
        # topical sentence in the chunk, and an embedding that cannot see it is
        # working from the body alone.
        lines.append(line)

    flush()
    return sections


def _paragraphs(text: str) -> list[str]:
    return [p for p in re.split(r"\n\s*\n", text) if p.strip()]


def _overlap_tail(paras: list[_Para], overlap_tokens: int) -> list[_Para]:
    """The last whole paragraphs that fit in *overlap_tokens*, in original order."""
    if overlap_tokens <= 0:
        return []
    kept: list[_Para] = []
    total = 0
    for para in reversed(paras):
        if kept and total + para.tokens > overlap_tokens:
            break
        kept.insert(0, para)
        total += para.tokens
    return kept


def _split_oversized(paras: list[_Para], *, max_tokens: int, min_tokens: int, overlap_tokens: int) -> list[list[_Para]]:
    """Cut on paragraph boundaries, carrying an overlap into each following piece.

    A piece is never flushed below ``min_tokens``, even to respect the cap. The section text
    opens with its own heading line, which is a paragraph of two or three tokens: cutting
    strictly on the cap emitted that heading as a chunk of its own — an embedding of the words
    "## Tokens" and nothing else, which retrieves noise and costs money. The same floor covers
    a short trailing paragraph.

    Each paragraph is tokenized ONCE and the running total is summed. Measuring the joined
    candidate on every step instead re-tokenizes an ever-growing string, which is quadratic in
    the length of the section — fine on a fixture, minutes on a real document.
    """
    if not paras:
        return []
    if sum(p.tokens for p in paras) <= max_tokens:
        return [list(paras)]

    pieces: list[list[_Para]] = []
    current: list[_Para] = []
    total = 0
    for para in paras:
        if current and total >= min_tokens and total + para.tokens > max_tokens:
            pieces.append(current)
            current = _overlap_tail(current, overlap_tokens)
            total = sum(p.tokens for p in current)
        current = [*current, para]
        total += para.tokens
    if current:
        pieces.append(current)
    # A single paragraph over the cap is left whole rather than cut mid-sentence: the
    # embedding degrades, but a chunk that stops mid-clause is worse and unciteable.
    return pieces


def chunk_markdown(
    text: str,
    *,
    doc_ref: str,
    doc_hash: str = "",
    max_tokens: int = MAX_TOKENS,
    min_tokens: int = MIN_TOKENS,
    overlap_tokens: int = OVERLAP_TOKENS,
) -> list[RagChunk]:
    """Chunk one markdown document.

    Frontmatter is stripped: it is metadata about the file, not content anyone searches for,
    and its keys embed as noise.
    """
    from flow_sdk.llm_index.markdown_document import MarkdownDocument  # noqa: PLC0415

    body = MarkdownDocument.from_text(text).body
    sections = split_sections(body)
    if not sections:
        return []

    # Every paragraph in the document, measured in ONE batch. Each character is then
    # tokenized exactly once: a section's size is the sum of its paragraphs' and a piece's is
    # the sum of the paragraphs it holds, so nothing downstream needs to re-measure. Counting
    # sections, then their paragraphs, then the emitted pieces put three passes over the same
    # text — three times the tokenizing for one answer.
    per_section = [_paragraphs(section.text) for section in sections]
    counts = _count_all([para for paras in per_section for para in paras])
    measured: list[list[_Para]] = []
    cursor = 0
    for paras in per_section:
        measured.append([_Para(t, counts[cursor + i]) for i, t in enumerate(paras)])
        cursor += len(paras)

    # Rule 2, before rule 3: a runt folds into its neighbour, and only then is the result
    # measured against the cap. Doing it the other way round would split a section and then
    # fold a piece of it back, which is a different document every time the order changes.
    folded: list[tuple[list[str], list[_Para]]] = []
    for section, paras in zip(sections, measured):
        if folded and sum(p.tokens for p in paras) < min_tokens:
            folded[-1][1].extend(paras)
            continue
        folded.append((section.heading_path, list(paras)))

    chunks: list[RagChunk] = []
    for heading_path, paras in folded:
        for piece in _split_oversized(
            paras, max_tokens=max_tokens, min_tokens=min_tokens, overlap_tokens=overlap_tokens
        ):
            body_text = "\n\n".join(p.text for p in piece)
            chunks.append(
                RagChunk(
                    chunk_id=RagChunk.make_id(doc_ref, heading_path, body_text),
                    doc_ref=doc_ref,
                    doc_hash=doc_hash,
                    ordinal=len(chunks),
                    heading_path=list(heading_path),
                    text=body_text,
                    text_hash=RagChunk.make_text_hash(body_text),
                    token_count=sum(p.tokens for p in piece),
                )
            )
    return chunks


__all__ = [
    "MAX_TOKENS",
    "MIN_TOKENS",
    "OVERLAP_TOKENS",
    "Section",
    "chunk_markdown",
    "split_sections",
]
