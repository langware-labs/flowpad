"""AssetRecord — a typed record for wiki asset markdown files.

Stores asset definitions as markdown files with YAML frontmatter.
Supports discovery of .md files across a project directory.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, ClassVar

from flow_sdk.fs_store import Record, RecordType

from ._frontmatter import (
    _extract_body,
    _extract_frontmatter,
    _yaml_load,
)

# Map from directory name to asset_type
_DIR_TO_ASSET_TYPE: dict[str, str] = {
    "workflows": "workflow",
    "skills": "skill",
    "agents": "agent",
    "memory": "memory",
    "docs": "doc",
    "templates": "template",
}


def _extract_wiki_links(body: str) -> list[str]:
    """Extract [[wiki link]] targets from markdown body."""
    return re.findall(r'\[\[([^\]]+)\]\]', body)


class AssetRecord(Record):
    """A record backed by a markdown asset file with YAML frontmatter."""

    _record_type: ClassVar[str] = RecordType.ASSET
    _indexed_by_default: ClassVar[bool] = True
    _user_asset: ClassVar[bool] = True
    index_fields: ClassVar[list[str]] = ["title", "tags", "links"]

    def __init__(self, **kwargs: Any):
        kwargs.setdefault("type", RecordType.ASSET)
        kwargs.setdefault("status", "active")
        super().__init__(**kwargs)

    @classmethod
    def from_markdown(cls, text: str, path: Path | None = None) -> "AssetRecord":
        """Parse a markdown string with YAML frontmatter into an AssetRecord."""
        fm_text = _extract_frontmatter(text)
        fields = _yaml_load(fm_text) if fm_text else {}
        body = _extract_body(text)

        # Determine asset_type
        asset_type = fields.get("asset_type")
        if not asset_type and path is not None:
            # Force skill type for SKILL.md
            if path.name == "SKILL.md":
                asset_type = "skill"
            else:
                # Infer from parent directory name
                parent_name = path.parent.name if path.parent else ""
                asset_type = _DIR_TO_ASSET_TYPE.get(parent_name, "doc")
        if not asset_type:
            asset_type = "doc"

        title = fields.get("title") or (path.stem if path else "Untitled")
        tags = fields.get("tags") or []
        if isinstance(tags, str):
            tags = [t.strip() for t in tags.split(",") if t.strip()]

        # Extract wiki links from body
        links = _extract_wiki_links(body) if body else []
        links.extend(fields.get("links") or [])

        asset_id = fields.get("asset_id") or fields.get("id") or (str(path) if path else None)
        parent_id = fields.get("parent_id")
        scope = fields.get("scope") or None

        data: dict[str, Any] = {
            "asset_type": asset_type,
            "title": title,
            "tags": tags,
            "links": links,
        }
        if asset_id:
            data["id"] = asset_id
        if parent_id:
            data["parent_id"] = parent_id
        if scope:
            data["scope"] = scope

        rec = cls(**data)
        # Set asset_ref to point to the source .md file (replaces _data["source_path"])
        if path is not None:
            from flow_sdk.fs_store.fs_ref import FSRef
            object.__setattr__(rec, "_asset_ref", FSRef(path))
        return rec

    @classmethod
    def from_file(cls, path: str | Path) -> "AssetRecord":
        """Load an AssetRecord from a .md file path."""
        p = Path(path)
        text = p.read_text(encoding="utf-8")
        return cls.from_markdown(text, path=p)

    @property
    def source_path(self) -> str | None:
        """Path to the source .md file. Compat accessor — prefer asset_ref.path."""
        ar = self.asset_ref
        if ar is not None:
            return ar.path
        return getattr(self, "source_path_field", None)

    def _fingerprint_paths(self):
        """Fingerprint the source .md file by mtime + size."""
        ar = self.asset_ref
        if ar is not None and ar.exists():
            return [ar._path]
        # Backward compat: read from source_path attr
        src = getattr(self, "source_path_field", None)
        if not src:
            return []
        p = Path(src)
        return [p] if p.exists() else []

    @property
    def name(self) -> str:  # type: ignore[override]
        return getattr(self, "title", "") or ""

    @name.setter
    def name(self, value: str) -> None:  # type: ignore[override]
        object.__setattr__(self, "title", value)
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add("title")

    @property
    def search_title(self) -> str | None:
        return getattr(self, "title", None) or None

    @property
    def search_description(self) -> str | None:
        tags = getattr(self, "tags", None) or []
        if tags:
            return ", ".join(str(t) for t in tags)
        return None

    @property
    def search_content(self) -> str | None:
        """Searchable text for FTS indexing: links (title/tags now in dedicated columns)."""
        parts: list[str] = []
        links = getattr(self, "links", None) or []
        if links:
            parts.append(" ".join(str(l) for l in links))
        return " ".join(parts) if parts else None

    @classmethod
    def discover(cls, project_dir: str | Path = "", **kwargs) -> list["AssetRecord"]:
        """Discover all .md files in project_dir and return AssetRecords."""
        results: list[AssetRecord] = []
        if not project_dir:
            return results
        p = Path(project_dir)
        for md_file in sorted(p.rglob("*.md")):
            try:
                results.append(cls.from_file(md_file))
            except Exception:
                continue
        return results
