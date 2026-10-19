"""TextExtractor conformance — Grammar v1 (spec §5): link occurrences, wiki words, H1."""
from __future__ import annotations

import pytest

from flow_sdk.diskio.contract import LinkGrammar, TextExtractor
from flow_sdk.llm_index.markdown_document import MarkdownDocument, extract_wiki_links
from flow_sdk.wiki.parser import parse_links
from tests.unit.diskio._backends import backends

GRAMMAR = LinkGrammar()


@pytest.fixture(params=backends(TextExtractor))
def extractor(request):
    return request.param()


def links(extractor, body: str) -> list[tuple[str, int, str | None]]:
    text = extractor.extract_text(body, GRAMMAR)
    got = [(link.raw, link.line, link.wiki_ref) for link in text.links]
    assert got == [(link.raw, link.line, link.wiki_ref) for link in parse_links(body)]
    assert list(text.wiki_words) == extract_wiki_links(body)
    return got


def test_wikilinks_carry_their_inner_text_and_line(extractor):
    body = "intro [[alpha]]\n\nsee [[beta|the alias]] and [[gamma#head]]\n"
    assert links(extractor, body) == [("alpha", 1, None), ("beta|the alias", 3, None), ("gamma#head", 3, None)]


def test_a_fenced_block_is_masked(extractor):
    body = "[[before]]\n```python\n[[inside]]\n```\n~~~\n[[tilde]]\n~~~\n[[after]]\n"
    assert links(extractor, body) == [("before", 1, None), ("after", 8, None)]


def test_a_fence_closes_only_on_the_identical_run(extractor):
    body = "````\n[[a]]\n```\n[[b]]\n````\n[[c]]\n"
    assert links(extractor, body) == [("c", 6, None)]


def test_inline_code_is_masked_and_an_empty_span_is_not(extractor):
    assert links(extractor, "use `[[code]]` not [[real]]\n") == [("real", 1, None)]
    assert links(extractor, "`` [[kept]]\n") == [("kept", 1, None)]


def test_an_embed_is_an_occurrence_but_not_a_wiki_word(extractor):
    text = extractor.extract_text("![[diagram]] and [[page]]\n", GRAMMAR)
    assert [link.raw for link in text.links] == ["diagram", "page"]
    assert text.wiki_words == ("page",)


def test_wiki_words_drop_alias_anchor_and_block_and_dedup_in_order(extractor):
    body = "[[b|x]] [[a#h]] [[b^blk]] [[ c ]] [[a/b]] [[|empty]]\n"
    assert extractor.extract_text(body, GRAMMAR).wiki_words == ("b", "a", "c", "a/b")


def test_wiki_words_are_read_from_the_unmasked_body(extractor):
    text = extractor.extract_text("`[[in code]]`\n", GRAMMAR)
    assert text.links == () and text.wiki_words == ("in code",)


def test_markdown_links_skip_http_and_keep_relative_md_paths(extractor):
    body = (
        "[ext](https://example.com/a.md) [also](http://example.com/b.md)\n"
        "[rel](./guide.md) [anchor](../x/y.md#part) [not md](./pic.png)\n"
    )
    assert links(extractor, body) == [("./guide.md", 2, None), ("../x/y.md#part", 2, None)]


def test_wiki_dock_urls(extractor):
    body = (
        "[one](/dock/assets/wiki/Page%20One)\n"
        "[two](/dock/assets/wiki/my-wiki/Page%20Two#frag)\n"
        "[hub](/dock/hub/assets/wiki/hub-wiki/Word)\n"
        "[hub root](/dock/hub/assets/wiki/hub-wiki)\n"
    )
    assert links(extractor, body) == [
        ("Page One", 1, None), ("Page Two", 2, "my-wiki"), ("Word", 3, "hub-wiki"), ("", 4, "hub-wiki"),
    ]


def test_a_wiki_url_ending_in_md_is_emitted_once(extractor):
    assert links(extractor, "[x](/dock/assets/wiki/w/page.md)\n") == [("page.md", 1, "w")]


def test_within_a_line_the_order_is_wiki_then_wiki_url_then_markdown(extractor):
    body = "[m](./m.md) [u](/dock/assets/wiki/U) [[w]]\nline two [[z]]\n"
    assert links(extractor, body) == [("w", 1, None), ("U", 1, None), ("./m.md", 1, None), ("z", 2, None)]


def test_a_lone_carriage_return_does_not_count_as_a_line(extractor):
    assert links(extractor, "a\rb [[x]]\nc [[y]]\r\n") == [("x", 1, None), ("y", 2, None)]


def test_h1_is_the_first_hash_line_stripped(extractor):
    assert extractor.extract_text("intro\n#  The Title  \n# Second\n", GRAMMAR).h1 == "The Title"
    assert extractor.extract_text("## not h1\n#nospace\n", GRAMMAR).h1 is None
    assert extractor.extract_text("", GRAMMAR).h1 is None
    body = "text\n# From Body\n"
    assert extractor.extract_text(body, GRAMMAR).h1 == MarkdownDocument(body=body).title


def test_an_empty_body(extractor):
    text = extractor.extract_text("", GRAMMAR)
    assert text.h1 is None and text.links == () and text.wiki_words == ()
