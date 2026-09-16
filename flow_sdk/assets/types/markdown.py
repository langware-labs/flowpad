"""Filesystem contracts independent of application entities."""
from __future__ import annotations

import re
from pathlib import Path

_WIKI_LINK_RE = re.compile(r"\[\[([^\]]+)\]\]")


def _extract_wiki_links(body: str) -> list[str]:
    """Extract [[wiki link]] inner text from markdown body.

    Returns the raw inner text — for ``[[target|alias]]`` this is
    ``target|alias``. Downstream callers (resolver/wiki) split the alias.
    """
    return [m.group(1).strip() for m in _WIKI_LINK_RE.finditer(body) if m.group(1).strip()]


_DIR_TO_ASSET_TYPE: dict[str, str] = {
    "workflows": "workflow",
    "skills": "skill",
    "agents": "subagent",
    "memory": "memory",
    "docs": "doc",
    "templates": "template",
}


def _derive(data: dict, root: Path, header_raw: dict, *, titled: bool) -> None:
    """The facts a markdown file's PATH and BODY carry that its frontmatter does
    not: the asset type (from the parent directory), the title (the stem), the
    name, the wiki-links scraped from the body, and the folder containment the
    wiki tree renders from."""
    if not data.get("asset_type"):
        data["asset_type"] = "skill" if root.name == "SKILL.md" else _DIR_TO_ASSET_TYPE.get(root.parent.name, "doc")
    if titled:
        data["title"] = data.get("title") or root.stem
        body = data.get("body") or ""
        links = _extract_wiki_links(body) if body else []
        links.extend(data.get("links") or [])
        data["links"] = links
    data["name"] = data.get("title") or root.stem
    try:
        data["parent_path"] = str(root.resolve().parent)
    except OSError:
        pass


def derive_markdown(data: dict, root: Path, header_raw: dict) -> None:
    _derive(data, root, header_raw, titled=True)


def derive_claude_md(data: dict, root: Path, header_raw: dict) -> None:
    _derive(data, root, header_raw, titled=False)
