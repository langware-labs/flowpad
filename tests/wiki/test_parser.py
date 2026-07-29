"""Unit tests for flow_sdk.wiki.parser.parse_links.

Pure function over a string. No DB, no records, no fixtures beyond pytest's.
"""

import pytest

from flow_sdk.wiki.parser import parse_links


def _raws(links):
    return [link.raw for link in links]


class TestWikilinks:
    def test_bare_wikilink(self):
        links = parse_links("See [[my-process]] for details.")
        assert len(links) == 1
        assert links[0].raw == "my-process"
        assert links[0].line == 1

    def test_wikilink_with_alias(self):
        links = parse_links("See [[my-process|the process]].")
        assert _raws(links) == ["my-process|the process"]

    def test_wikilink_with_heading(self):
        links = parse_links("See [[my-process#install]].")
        assert _raws(links) == ["my-process#install"]

    def test_wikilink_with_block(self):
        links = parse_links("See [[my-process^abc-123]].")
        assert _raws(links) == ["my-process^abc-123"]

    def test_wikilink_with_path(self):
        links = parse_links("See [[my-skill/resources/setup.txt]].")
        assert _raws(links) == ["my-skill/resources/setup.txt"]

    def test_embed(self):
        links = parse_links("![[my-process]]")
        assert _raws(links) == ["my-process"]

    def test_combined_alias_heading(self):
        links = parse_links("See [[my-process#install|Setup Guide]].")
        assert _raws(links) == ["my-process#install|Setup Guide"]


class TestMarkdownLinks:
    def test_internal_md_link(self):
        links = parse_links("See [the process](./my-process.md) for details.")
        assert _raws(links) == ["./my-process.md"]

    def test_md_link_with_fragment(self):
        links = parse_links("See [section](./my-process.md#install).")
        assert _raws(links) == ["./my-process.md#install"]

    def test_external_link_is_ignored(self):
        links = parse_links("See [docs](https://example.com/x.md).")
        assert links == []

    def test_non_md_link_is_ignored(self):
        links = parse_links("See [docs](./image.png).")
        assert links == []

    def test_wiki_dock_url_is_extracted(self):
        # The toolbar emits this form when "Add entity link" inserts a
        # real link node. The parser must extract the name segment.
        links = parse_links("See [my-process](/dock/assets/wiki/my-process).")
        assert _raws(links) == ["my-process"]

    def test_wiki_dock_url_decodes_percent_encoded_name(self):
        links = parse_links("See [my proc](/dock/assets/wiki/my%20proc).")
        assert _raws(links) == ["my proc"]

    def test_wiki_dock_url_with_fragment(self):
        links = parse_links("See [foo](/dock/assets/wiki/foo#install).")
        assert _raws(links) == ["foo"]

    def test_canonical_local_wiki_url_carries_namespace(self):
        links = parse_links("See [foo](/dock/assets/wiki/@local/foo).")
        assert _raws(links) == ["foo"]
        assert links[0].wiki_ref == "@local"

    def test_canonical_hub_wiki_url_carries_namespace(self):
        links = parse_links("See [foo](/dock/hub/assets/wiki/@team/foo%20bar).")
        assert _raws(links) == ["foo bar"]
        assert links[0].wiki_ref == "@team"


class TestCodeFenceSkipping:
    def test_links_inside_fenced_block_are_skipped(self):
        body = "Outside [[outside]]\n```\n[[inside]]\n```\nAfter [[after]]"
        assert _raws(parse_links(body)) == ["outside", "after"]

    def test_links_inside_inline_code_are_skipped(self):
        body = "Use `[[fake]]` syntax for [[real]] links."
        assert _raws(parse_links(body)) == ["real"]

    def test_md_links_inside_fenced_block_are_skipped(self):
        body = "```\n[fake](./x.md)\n```\n[real](./y.md)"
        assert _raws(parse_links(body)) == ["./y.md"]

    def test_tilde_fenced_block_is_skipped(self):
        body = "~~~\n[[hidden]]\n~~~\n[[visible]]"
        assert _raws(parse_links(body)) == ["visible"]


class TestMultipleLinks:
    def test_two_links_same_line(self):
        links = parse_links("See [[a]] and [[b]] together.")
        assert _raws(links) == ["a", "b"]
        assert all(link.line == 1 for link in links)

    def test_links_across_lines(self):
        body = "First [[one]]\nthen [[two]]\nfinally [[three]]"
        links = parse_links(body)
        assert [(link.raw, link.line) for link in links] == [
            ("one", 1),
            ("two", 2),
            ("three", 3),
        ]

    def test_mixed_wiki_and_md_links(self):
        body = "[[wiki-target]] and [text](./md-target.md)"
        assert sorted(_raws(parse_links(body))) == sorted(
            ["wiki-target", "./md-target.md"]
        )

    def test_repeats_are_kept_per_occurrence(self):
        body = "[[same]] and [[same]] again."
        assert _raws(parse_links(body)) == ["same", "same"]


class TestEmpty:
    def test_empty_body(self):
        assert parse_links("") == []

    def test_no_links(self):
        assert parse_links("Plain text with no links.") == []
