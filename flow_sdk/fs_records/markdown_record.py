"""MarkdownRecord — a typed record for wiki asset markdown files.

Stores asset definitions as markdown files with YAML frontmatter.
Supports discovery of .md files across a project directory.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from typing import Any, ClassVar, Iterator

from flow_sdk.fs_store import Record, RecordType

from ._frontmatter import (
    _extract_body,
    _extract_frontmatter,
    _yaml_load,
)

_WALK_IGNORED: frozenset[str] = frozenset({
    ".git", "node_modules", ".venv", "venv", "__pycache__",
    ".tox", "dist", "build", ".eggs", ".mypy_cache", ".pytest_cache",
    ".ruff_cache", ".next", ".nuxt", "coverage", ".cache",
})


_DOCS_WALK_MAX_DEPTH = 3


def _find_docs_subdirs(root: Path) -> list[Path]:
    """Return all directories named 'docs' anywhere under root.

    Skips common noise directories (node_modules, .git, build outputs, etc.)
    and stops at _DOCS_WALK_MAX_DEPTH levels deep to keep the walk fast.
    """
    found: list[Path] = []
    root_depth = len(root.parts)
    try:
        for dirpath, dirnames, _ in os.walk(root, topdown=True):
            p = Path(dirpath)
            depth = len(p.parts) - root_depth
            if depth >= _DOCS_WALK_MAX_DEPTH:
                dirnames.clear()
                continue
            dirnames[:] = [d for d in dirnames if d not in _WALK_IGNORED]
            if p.name == "docs":
                found.append(p)
    except PermissionError:
        pass
    return found


def _doc_search_dirs() -> list[Path]:
    """Return directories to scan for doc .md files.

    Scans user-level (~/.claude/docs), all known Claude projects
    (every 'docs' directory anywhere in each project tree, plus
    <project>/.claude/docs), cwd-level, and any extra dirs from
    FLOWPAD_DOC_DIRS (colon-separated).
    """
    dirs: list[Path] = []
    seen: set[Path] = set()

    def _add(p: Path) -> None:
        rp = p.resolve()
        if rp not in seen and rp.is_dir():
            seen.add(rp)
            dirs.append(p)

    _add(Path.home() / ".claude" / "docs")

    from flow_sdk.fs_records._claude_projects import iter_claude_project_paths
    for real in iter_claude_project_paths():
        for docs_dir in _find_docs_subdirs(real):
            _add(docs_dir)
        _add(real / ".claude" / "docs")

    _add(Path(os.getcwd()) / ".claude" / "docs")
    for docs_dir in _find_docs_subdirs(Path(os.getcwd())):
        _add(docs_dir)

    for extra in os.environ.get("FLOWPAD_DOC_DIRS", "").split(":"):
        if extra.strip():
            _add(Path(extra.strip()))

    return dirs


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


class MarkdownRecord(Record):
    """A record backed by a markdown asset file with YAML frontmatter."""

    _record_type: ClassVar[str] = RecordType.DOCS
    _indexed_by_default: ClassVar[bool] = True
    _user_asset: ClassVar[bool] = True
    _icon: ClassVar[str] = "BookOpen"
    index_fields: ClassVar[list[str]] = ["title", "tags", "links"]

    def __init__(self, **kwargs: Any):
        kwargs.setdefault("type", RecordType.DOCS)
        kwargs.setdefault("status", "active")
        super().__init__(**kwargs)

    @classmethod
    def from_markdown(cls, text: str, path: Path | None = None) -> "MarkdownRecord":
        """Parse a markdown string with YAML frontmatter into a MarkdownRecord."""
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

        raw_id = fields.get("asset_id") or fields.get("id")
        if not raw_id and path is not None:
            import uuid
            asset_id = str(uuid.uuid5(uuid.NAMESPACE_URL, str(path.resolve())))
        else:
            asset_id = raw_id
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
    def from_file(cls, path: str | Path) -> "MarkdownRecord":
        """Load a MarkdownRecord from a .md file path."""
        p = Path(path)
        text = p.read_text(encoding="utf-8")
        return cls.from_markdown(text, path=p)

    @property
    def source_path(self) -> str | None:
        """Path to the source .md file. Compat accessor — prefer asset_ref.path."""
        ar = self.asset_ref
        if ar is not None:
            return ar.path
        # also check attrs written by save()
        return getattr(self, "source_path_field", None) or getattr(self, "asset_ref_path", None)

    def _fingerprint_paths(self):
        """Fingerprint the source .md file by mtime + size."""
        ar = self.asset_ref
        if ar is not None and ar.exists():
            return [ar._path]
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
        """Searchable text for FTS indexing: body text + wiki links."""
        parts: list[str] = []
        ar = self.asset_ref
        if ar is not None and ar.exists():
            try:
                body = _extract_body(Path(ar.path).read_text(encoding="utf-8"))
                if body:
                    parts.append(body)
            except Exception:
                pass
        links = getattr(self, "links", None) or []
        if links:
            parts.append(" ".join(str(l) for l in links))
        return " ".join(parts) if parts else None

    def meta_dict(self) -> dict:
        result = super().meta_dict()
        sp = self.source_path
        if sp:
            result["source_path"] = sp
        result["name"] = self.name
        return result

    @classmethod
    def _external_source_count(cls, limit: int | None = None) -> int:
        seen: set[str] = set()
        for docs_dir in _doc_search_dirs():
            for md_file in docs_dir.rglob("*.md"):
                seen.add(str(md_file.resolve()))
        count = len(seen)
        return min(count, limit) if limit is not None else count

    @classmethod
    def _external_source_iter(cls, limit: int | None = None) -> Iterator["MarkdownRecord"]:
        seen: set[str] = set()
        count = 0
        for docs_dir in _doc_search_dirs():
            for md_file in sorted(docs_dir.rglob("*.md")):
                key = str(md_file.resolve())
                if key in seen:
                    continue
                seen.add(key)
                try:
                    yield cls.from_file(md_file)
                    count += 1
                    if limit is not None and count >= limit:
                        return
                except Exception:
                    continue

    @classmethod
    def discover(cls, project_dir: str | Path = "", **kwargs) -> list["MarkdownRecord"]:
        """Discover MarkdownRecords.

        If project_dir is given: walk all .md files in that directory tree.
        Otherwise: use _external_source_iter() to discover from source files
        directly, bypassing the stale records-root cache.
        """
        if not project_dir:
            # Always discover from source files — the records-root cache may
            # have stale metadata (e.g. title="") that would shadow fresh data.
            return list(cls._external_source_iter())
        results: list[MarkdownRecord] = []
        p = Path(project_dir)
        for md_file in sorted(p.rglob("*.md")):
            try:
                results.append(cls.from_file(md_file))
            except Exception:
                continue
        return results
