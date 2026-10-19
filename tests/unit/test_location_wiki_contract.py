"""The location glyphs deep-link into a shipped wiki page — pin that contract.

`EntityIcon.tsx` names a wiki page by TITLE and each glyph's section by heading
SLUG. Nothing at runtime fails when either drifts: the modal opens on a missing
page, or opens the right page and scrolls nowhere. Since that page is now
reachable from every asset glyph in the app, it is the most-linked page in the
product and deserves a guard.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
ENTITY_ICON = REPO_ROOT / "ui/src/components/graph-view/ui/EntityIcon.tsx"
DOCS_DIR = REPO_ROOT / "flow_sdk/system_projects/flowpad_assistant/docs"


def gfm_slug(text: str) -> str:
    """Mirror of ``gfmSlug`` in MarkdownEditor.tsx — the two MUST agree."""
    slug = re.sub(r"[^\w\s-]", "", text.lower()).strip()
    return re.sub(r"-+", "-", re.sub(r"\s+", "-", slug))


def _page_by_title(title: str) -> Path | None:
    """Wiki pages resolve by title, which is the filename and the H1."""
    for path in DOCS_DIR.rglob("*.md"):
        if path.stem == title:
            return path
    return None


def _entity_icon_source() -> str:
    return ENTITY_ICON.read_text(encoding="utf-8")


def test_location_wiki_page_exists() -> None:
    match = re.search(r"LOCATION_WIKI_PAGE\s*=\s*'([^']+)'", _entity_icon_source())
    assert match, "EntityIcon no longer declares LOCATION_WIKI_PAGE"
    title = match.group(1)
    assert _page_by_title(title) is not None, (
        f"EntityIcon deep-links to the wiki page {title!r}, but no "
        f"{title}.md exists under {DOCS_DIR.relative_to(REPO_ROOT)}"
    )


def test_every_location_fragment_matches_a_heading() -> None:
    source = _entity_icon_source()
    title = re.search(r"LOCATION_WIKI_PAGE\s*=\s*'([^']+)'", source).group(1)
    page = _page_by_title(title)
    assert page is not None

    block = re.search(r"LOCATION_WIKI_FRAGMENT[^{]*\{(.*?)\}", source, re.S)
    assert block, "EntityIcon no longer declares LOCATION_WIKI_FRAGMENT"
    fragments = dict(re.findall(r"(\w+)\s*:\s*'([^']+)'", block.group(1)))
    assert set(fragments) == {"cloud", "local", "git"}, fragments

    headings = {
        gfm_slug(line.lstrip("#").strip())
        for line in page.read_text(encoding="utf-8").splitlines()
        if line.startswith("#")
    }
    for key, fragment in fragments.items():
        assert fragment in headings, (
            f"the {key} glyph deep-links to #{fragment}, which is not a heading "
            f"in {page.name} — the link would silently scroll nowhere"
        )


@pytest.mark.parametrize(
    "page_title",
    ["Data privacy modes", "Where your assets live"],
)
def test_wiki_links_between_the_location_pages_resolve(page_title: str) -> None:
    page = _page_by_title(page_title)
    assert page is not None, f"{page_title}.md is missing"
    for link in re.findall(r"\[\[([^\]]+)\]\]", page.read_text(encoding="utf-8")):
        assert _page_by_title(link) is not None, (
            f"{page.name} links to [[{link}]], which has no page"
        )
