"""TextExtractor — spec §5. Link occurrences are ``wiki.parser.parse_links``;
wiki words and the H1 are ``llm_index.markdown_document``'s two rules."""

from __future__ import annotations

from flow_sdk.diskio.contract import DocText, LinkGrammar, LinkOccurrence
from flow_sdk.llm_index.markdown_document import _H1_RE, extract_wiki_links
from flow_sdk.wiki.parser import parse_links

GRAMMAR_V1 = LinkGrammar()


class PyTextExtractor:
    def extract_text(self, body: str, grammar: LinkGrammar) -> DocText:
        if grammar != GRAMMAR_V1:
            raise ValueError("the Python TextExtractor reads Grammar v1 with its default fields only")
        h1 = _H1_RE.search(body)
        return DocText(
            h1=h1.group(1).strip() if h1 else None,
            links=tuple(
                LinkOccurrence(raw=link.raw, line=link.line, wiki_ref=link.wiki_ref)
                for link in parse_links(body)
            ),
            wiki_words=tuple(extract_wiki_links(body)),
        )
