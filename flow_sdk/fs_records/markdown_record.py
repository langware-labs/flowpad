"""MarkdownRecord — a typed record for wiki asset markdown files.

Stores asset definitions as markdown files with YAML frontmatter.
Supports discovery of .md files across a project directory.
"""

from __future__ import annotations

import os
import re
import uuid
from pathlib import Path

from typing import Any, ClassVar

from flow_sdk.fs_store import Record, RecordType

from ._frontmatter import (
    _extract_body,
    _extract_frontmatter,
    _render_frontmatter,
    _yaml_load,
)  # noqa: F401  (_render_frontmatter is used by default_body)

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

    # SDK-shipped system docs under the Flowpad Assistant system project.
    try:
        from flow_sdk.config import flowpad_assistant_project_root
        _add(flowpad_assistant_project_root() / ".claude" / "docs")
    except Exception:
        pass

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


def _resolve_vault_root(path: Path) -> str | None:
    """Return the canonical abs path of the scan root that owns `path`, if any.

    Walks _doc_search_dirs() looking for the first root that is an ancestor of
    `path.resolve()`. Resolved before comparison so symlinks agree.
    """
    try:
        target = path.resolve()
    except OSError:
        return None
    for root in _doc_search_dirs():
        try:
            root_resolved = root.resolve()
        except OSError:
            continue
        try:
            target.relative_to(root_resolved)
        except ValueError:
            continue
        return str(root_resolved)
    return None


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

    _record_type: ClassVar[str] = RecordType.MARKDOWN
    _indexed_by_default: ClassVar[bool] = True
    _user_asset: ClassVar[bool] = True
    _creatable: ClassVar[bool] = True
    _icon: ClassVar[str] = "BookOpen"
    index_fields: ClassVar[list[str]] = ["title", "tags", "links"]

    # Framework upsert: <scope_root>/.claude/docs/<safe_name>.md
    _main_subdir: ClassVar[str] = ".claude/docs"
    _main_layout: ClassVar[str] = "file"

    def __init__(self, **kwargs: Any):
        kwargs.setdefault("type", RecordType.MARKDOWN)
        kwargs.setdefault("status", "active")
        super().__init__(**kwargs)

    @property
    def main_ref(self) -> "Any":  # FrontMatterFsRef | None
        """Primary content ref points at the .md file via asset_ref."""
        from flow_sdk.fs_store.fs_ref import FrontMatterFsRef
        ar = self.asset_ref
        if ar is not None:
            return FrontMatterFsRef(ar._path)
        return None

    def default_body(self, entity) -> "str | None":
        # Stamp asset_id into frontmatter so the indexer's getId reads back
        # the same id and never creates a duplicate Record on next scan.
        name = (getattr(entity, "name", None) or "").strip() or "Untitled"
        return _render_frontmatter({"asset_id": entity.id, "title": name}) + f"\n# {name}\n"

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

        # Folder containment for the Obsidian-style wiki tree. parent_path is the
        # immediate containing directory (canonical absolute path). vault_root is
        # the scan root that owns the file (one of _doc_search_dirs entries).
        if path is not None:
            try:
                resolved = path.resolve()
                data["parent_path"] = str(resolved.parent)
            except OSError:
                pass
            vault = _resolve_vault_root(path)
            if vault:
                data["vault_root"] = vault

        rec = cls(**data)
        # Set asset_ref to point to the source .md file
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

    def _asset_paths(self):
        """The source .md file."""
        ar = self.asset_ref
        if ar is not None and ar.exists():
            return [ar._path]
        return []

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

    def wiki_body(self) -> str | None:
        """Read the markdown body from the asset file for wiki link extraction."""
        ar = self.asset_ref
        if ar is None or not ar.exists():
            return None
        try:
            return _extract_body(Path(ar.path).read_text(encoding="utf-8"))
        except Exception:
            return None

    def meta_dict(self) -> dict:
        # Base Record.meta_dict injects asset_ref; we only set the display name.
        result = super().meta_dict()
        result["name"] = self.name
        return result

    @classmethod
    async def from_fsref(cls, ref) -> list["MarkdownRecord"]:
        """Indexer entry point — construct from an FSRef emitted by markdown_fn."""
        return [cls.from_file(ref._path)]

    # ── Portable identity (Phase 7c) ─────────────────────────────────────────
    # MarkdownRecord opts into `asset_id` minting: genId writes a stable uuid
    # into the file's YAML frontmatter on first encounter, so the id survives
    # path moves / cross-machine sync. getId is read-only.

    _mintable: ClassVar[bool] = True

    @classmethod
    def _read_frontmatter_asset_id(cls, path: Path) -> str | None:
        """Return `asset_id` from the file's frontmatter, or None if absent."""
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            return None
        fm = _extract_frontmatter(text)
        if not fm:
            return None
        fields = _yaml_load(fm) or {}
        raw = fields.get("asset_id") or fields.get("id")
        return str(raw).strip() if isinstance(raw, str) and raw.strip() else None

    @classmethod
    def getId(cls, ref) -> str:
        """asset_id from frontmatter when present; else uuid5 of resolved path."""
        existing = cls._read_frontmatter_asset_id(ref._path)
        if existing:
            return existing
        return str(uuid.uuid5(uuid.NAMESPACE_URL, str(ref._path.resolve())))

    @classmethod
    def genId(cls, ref) -> str:
        """Read asset_id, or mint one into the frontmatter and return it.

        Idempotent: if the file already has an `asset_id`, no write happens.
        Otherwise a fresh `uuid4()` is inserted at the top of the frontmatter,
        preserving every other field and the markdown body verbatim.
        """
        existing = cls._read_frontmatter_asset_id(ref._path)
        if existing:
            return existing
        new_id = str(uuid.uuid4())
        try:
            text = ref._path.read_text(encoding="utf-8")
        except OSError:
            return new_id  # can't write; still return a usable id
        fm = _extract_frontmatter(text)
        body = _extract_body(text)
        fields: dict = {}
        if fm:
            parsed = _yaml_load(fm)
            if isinstance(parsed, dict):
                fields.update(parsed)
        # Insert asset_id at the front for readability
        merged = {"asset_id": new_id, **{k: v for k, v in fields.items() if k not in ("asset_id",)}}
        try:
            ref._path.write_text(
                _render_frontmatter(merged) + "\n\n" + body + ("\n" if body and not body.endswith("\n") else ""),
                encoding="utf-8",
            )
        except OSError:
            pass
        return new_id

