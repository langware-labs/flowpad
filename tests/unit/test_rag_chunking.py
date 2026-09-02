"""The markdown chunker: what a document becomes before anything is embedded.

The assertions that matter are the identity ones. A chunk id has to be a function of the text
and where it sits, and nothing else — that is the whole mechanism by which a re-index costs
nothing when nothing changed, and costs one section when one section changed. Everything else
here is shape.
"""

from __future__ import annotations

import pytest

from flow_sdk.rag.chunking import chunk_markdown, split_sections
from flow_sdk.schema.data_spec.rag_spec import RagChunk

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


DOC = """---
title: Frontmatter is not content
id: 11111111-2222-4333-8444-555555555555
---

An opening paragraph before any heading, long enough that it stands on its own.

# Auth

How authentication works here, described with enough words to survive the fold.

## Tokens

Refresh tokens rotate on every use and the previous one is revoked immediately.

## Sessions

A session outlives a token and is revoked separately, which trips people up.
"""


def _by_path(chunks, path):
    return [c for c in chunks if c.heading_path == path]


# ── structure ────────────────────────────────────────────────────────────────


def test_headings_become_the_citation_path():
    """A hit says "Auth › Tokens", which is why heading-splitting is worth doing."""
    chunks = chunk_markdown(DOC, doc_ref="auth.md", min_tokens=1)
    assert [c.heading_path for c in chunks] == [[], ["Auth"], ["Auth", "Tokens"], ["Auth", "Sessions"]]


def test_text_before_the_first_heading_is_kept():
    """Often the best answer in the document; dropping it was the obvious bug to avoid."""
    chunks = chunk_markdown(DOC, doc_ref="auth.md", min_tokens=1)
    assert "An opening paragraph" in chunks[0].text
    assert chunks[0].heading_path == []


def test_the_heading_line_rides_with_its_body():
    """The most topical sentence in the chunk. An embedding that cannot see it is guessing."""
    chunks = chunk_markdown(DOC, doc_ref="auth.md", min_tokens=1)
    assert _by_path(chunks, ["Auth", "Tokens"])[0].text.startswith("## Tokens")


def test_frontmatter_is_not_indexed():
    chunks = chunk_markdown(DOC, doc_ref="auth.md", min_tokens=1)
    assert not any("Frontmatter is not content" in c.text for c in chunks)
    assert not any("11111111" in c.text for c in chunks)


def test_a_hash_inside_a_fence_is_not_a_heading():
    """Otherwise a Python comment cuts a code sample in half."""
    body = "# Real\n\nProse.\n\n```python\n# not a heading\nx = 1\n```\n\nMore prose.\n"
    assert [s.heading_path for s in split_sections(body)] == [["Real"]]


@pytest.mark.parametrize("fence", ["```", "~~~"])
def test_both_fence_styles_are_honoured(fence):
    body = f"# Real\n\n{fence}\n# not a heading\n{fence}\n"
    assert [s.heading_path for s in split_sections(body)] == [["Real"]]


def test_a_longer_fence_is_not_closed_by_a_shorter_one():
    """How every document that shows markdown is written: a four-backtick block quoting a
    three-backtick one. A plain open/closed toggle ends the outer fence at the inner opener."""
    body = "# Real\n\n````markdown\n```\n# not a heading\n```\n````\n\nAfter.\n"
    assert [s.heading_path for s in split_sections(body)] == [["Real"]]


def test_a_tilde_line_does_not_close_a_backtick_fence():
    """CommonMark closes a fence only with the same character."""
    body = "# Real\n\n```\n~~~\n# not a heading\n```\n\nAfter.\n"
    assert [s.heading_path for s in split_sections(body)] == [["Real"]]


def test_a_line_with_an_info_string_never_closes_a_fence():
    body = "# Real\n\n```\n```python\n# not a heading\n```\n"
    assert [s.heading_path for s in split_sections(body)] == [["Real"]]


def test_an_unclosed_fence_swallows_the_rest_of_the_document():
    """The same call CommonMark makes. Guessing a close would invent headings from code."""
    assert [s.heading_path for s in split_sections("# Real\n\n```\n# swallowed\n")] == [["Real"]]


def test_deeper_heading_nests_and_a_sibling_pops():
    body = "# A\n\nx\n\n## B\n\ny\n\n### C\n\nz\n\n## D\n\nw\n"
    assert [s.heading_path for s in split_sections(body)] == [["A"], ["A", "B"], ["A", "B", "C"], ["A", "D"]]


def test_an_empty_document_yields_nothing():
    assert chunk_markdown("", doc_ref="empty.md") == []
    assert chunk_markdown("---\ntitle: only frontmatter\n---\n", doc_ref="empty.md") == []


# ── the size rules ───────────────────────────────────────────────────────────


def test_a_runt_section_folds_into_the_one_before_it():
    """A heading with two words under it retrieves badly and still costs an embedding."""
    body = "# Big\n\n" + " ".join(["padding"] * 200) + "\n\n## Tiny\n\nTwo words.\n"
    chunks = chunk_markdown(body, doc_ref="d.md", min_tokens=64, max_tokens=4096)
    assert len(chunks) == 1
    assert "Two words." in chunks[0].text


def test_a_leading_runt_survives_alone():
    """There is nothing before it to fold into, and dropping it would lose content."""
    chunks = chunk_markdown("Tiny intro.\n\n# After\n\nMore text here to be a real section.\n",
                            doc_ref="d.md", min_tokens=64, max_tokens=4096)
    assert "Tiny intro." in chunks[0].text


def test_an_oversized_section_splits_with_overlap():
    body = "# Big\n\n" + "\n\n".join(f"Paragraph {i} with several words of filler text." for i in range(60))
    chunks = chunk_markdown(body, doc_ref="d.md", max_tokens=100, overlap_tokens=30, min_tokens=1)
    assert len(chunks) > 1
    # The tail of one piece opens the next, so a sentence across the cut is findable from both.
    assert chunks[1].text.split("\n\n")[0] in chunks[0].text


def test_every_piece_respects_the_cap_within_one_paragraph():
    body = "# Big\n\n" + "\n\n".join(f"Paragraph {i} with several words of filler text." for i in range(60))
    chunks = chunk_markdown(body, doc_ref="d.md", max_tokens=100, overlap_tokens=0, min_tokens=1)
    assert max(c.token_count for c in chunks) <= 100


def test_a_single_giant_paragraph_is_left_whole():
    """Cutting mid-sentence produces a chunk nobody can cite. Degrade, do not mangle."""
    body = "# Big\n\n" + " ".join(["word"] * 900)
    chunks = chunk_markdown(body, doc_ref="d.md", max_tokens=100)
    assert len(chunks) == 1


def test_a_heading_is_never_a_chunk_by_itself():
    """The section text opens with its own heading line, which is a two-token paragraph.
    Splitting strictly on the cap emitted it alone — an embedding of "# Big" and nothing else."""
    body = "# Big\n\n" + " ".join(["word"] * 900)
    assert chunk_markdown(body, doc_ref="d.md", max_tokens=100)[0].text.count("word") > 1


# ── identity: the assertions the whole design rests on ───────────────────────


def test_chunking_the_same_document_twice_yields_the_same_ids():
    """A no-op re-index must embed nothing, and this is why it can."""
    first = chunk_markdown(DOC, doc_ref="auth.md", min_tokens=1)
    second = chunk_markdown(DOC, doc_ref="auth.md", min_tokens=1)
    assert [c.chunk_id for c in first] == [c.chunk_id for c in second]


def test_the_file_hash_does_not_enter_the_chunk_id():
    """Otherwise a one-word fix anywhere re-embeds every chunk in the document."""
    a = chunk_markdown(DOC, doc_ref="auth.md", doc_hash="before", min_tokens=1)
    b = chunk_markdown(DOC, doc_ref="auth.md", doc_hash="after", min_tokens=1)
    assert [c.chunk_id for c in a] == [c.chunk_id for c in b]
    assert b[0].doc_hash == "after"


def test_editing_one_section_changes_only_that_chunks_id():
    before = chunk_markdown(DOC, doc_ref="auth.md", min_tokens=1)
    after = chunk_markdown(DOC.replace("revoked immediately", "revoked after a grace period"),
                           doc_ref="auth.md", min_tokens=1)
    changed = {c.chunk_id for c in after} - {c.chunk_id for c in before}
    assert len(changed) == 1
    assert _by_path(after, ["Auth", "Tokens"])[0].chunk_id in changed


def test_inserting_a_section_leaves_the_untouched_ones_alone():
    """Ordinal is NOT in the id, so everything below an insertion keeps its embedding."""
    before = chunk_markdown(DOC, doc_ref="auth.md", min_tokens=1)
    after = chunk_markdown(
        DOC.replace("## Sessions", "## Scopes\n\nScopes narrow what a token may do.\n\n## Sessions"),
        doc_ref="auth.md",
        min_tokens=1,
    )
    kept = {c.chunk_id for c in before} & {c.chunk_id for c in after}
    assert len(kept) == len(before)


def test_the_same_text_in_two_documents_is_two_chunks():
    """Shared boilerplate must stay resolvable back to the document it was found in."""
    shared = "# Notice\n\nThe same paragraph appears in both of these documents verbatim.\n"
    a = chunk_markdown(shared, doc_ref="one.md", min_tokens=1)
    b = chunk_markdown(shared, doc_ref="two.md", min_tokens=1)
    assert a[0].chunk_id != b[0].chunk_id
    # ...but it is one embedding, because the cache keys on the text alone.
    assert a[0].text_hash == b[0].text_hash


def test_the_same_text_under_a_different_heading_is_a_different_chunk():
    a = chunk_markdown("# One\n\nIdentical body text here for the test.\n", doc_ref="d.md", min_tokens=1)
    b = chunk_markdown("# Two\n\nIdentical body text here for the test.\n", doc_ref="d.md", min_tokens=1)
    assert a[0].chunk_id != b[0].chunk_id


def test_ids_are_hex_digests_and_text_hash_is_the_text_alone():
    chunk = chunk_markdown(DOC, doc_ref="auth.md", min_tokens=1)[0]
    assert len(chunk.chunk_id) == 64 and int(chunk.chunk_id, 16) >= 0
    assert chunk.text_hash == RagChunk.make_text_hash(chunk.text)


def test_ordinals_are_dense_and_in_document_order():
    chunks = chunk_markdown(DOC, doc_ref="auth.md", min_tokens=1)
    assert [c.ordinal for c in chunks] == list(range(len(chunks)))


def test_a_chunk_is_frozen():
    """It crosses a process boundary as JSON; nothing may edit one in flight."""
    chunk = chunk_markdown(DOC, doc_ref="auth.md", min_tokens=1)[0]
    with pytest.raises(Exception):
        chunk.text = "rewritten"
