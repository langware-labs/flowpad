"""Walkers + extractor + helpers for MARKDOWN records.

Walkers:
  markdown_flat_fn
      rglob <root>/.claude/docs/**/*.md.
      Register on USER_HOME_FOLDER only — ``~/`` is a huge tree where
      unrestricted ``docs/`` discovery would pick up unrelated dirs from
      venvs, npm packages, etc. The narrow ``.claude/docs`` prefix keeps
      home-dir scanning bounded.

  markdown_in_folder_fn
      Per-FOLDER emitter. Receives FOLDER refs from
      ``project_folder_walker_fn`` (which already pruned via gitignore +
      _WALK_IGNORED) and emits the direct ``*.md`` children of every
      walked folder. Register on FOLDER. Gitignore is the only filter —
      every ``.md`` in a project (or system project) is indexed.

Replaces the deleted ``MarkdownRecord`` subclass. ``parse_markdown_text``
is exported so other consumers (e.g. ``extract_markdown_index``) can share the
frontmatter+body parse without inheriting from a Record subclass.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer._frontmatter import (
    _extract_body,
    _extract_frontmatter,
    _yaml_load,
    adopt_or_mint_id,
)
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


def _is_appledouble(name: str) -> bool:
    """True for macOS AppleDouble sidecars (``._foo.md``) — binary
    resource-fork files that share a ``.md`` extension but never hold real
    markdown. Indexing them only raises a UnicodeDecodeError downstream."""
    return name.startswith("._")


def _emit_md_rglob(
    root: Path, parent: FSRef, out: list[FSRef], seen: set[str],
) -> None:
    if not root.is_dir():
        return
    for md in sorted(root.rglob("*.md")):
        if _is_appledouble(md.name):
            continue
        key = str(md.resolve())
        if key in seen:
            continue
        seen.add(key)
        out.append(FSRef(md, record_type=RecordType.MARKDOWN, parent=parent))

def markdown_flat_fn(
    nodes: list[FSRef], opts: IndexerOptions,
) -> list[FSRef]:
    """<root>/.claude/docs/**/*.md — flat, no docs-subdir search."""
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        _emit_md_rglob(Path(node.path) / ".claude" / "docs", node, out, seen)
    return out

# Folders whose .md children are claimed by typed indexers (skill_fn, agent_fn,
# workflow_fn, command_fn). Skip emission to avoid double-indexing a SKILL.md
# as both SKILL and MARKDOWN.
_TYPED_RECORD_DIRS: frozenset[str] = frozenset({
    "skills", "agents", "workflows", "commands", "whiteboards", "tasks",
})

def _has_typed_ancestor(folder: Path) -> bool:
    """True if ``folder`` itself or any ancestor is a typed-record dir."""
    p = folder
    while True:
        if p.name in _TYPED_RECORD_DIRS:
            return True
        if p.parent == p:
            return False
        p = p.parent

def markdown_in_folder_fn(
    nodes: list[FSRef], opts: IndexerOptions,
) -> list[FSRef]:
    """For each walked FOLDER, emit its direct ``*.md`` children.

    The walker already descended every subdirectory and filtered via
    gitignore + ``_WALK_IGNORED``; this function only emits — no glob
    recursion needed (use ``glob`` not ``rglob``).

    Folders under typed-record dirs (``skills/``, ``agents/``, ``workflows/``,
    ``commands/``) are skipped so SKILL.md / agent .md / workflow .md aren't
    double-indexed as MARKDOWN.
    """
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        if node.record_type != RecordType.FOLDER:
            continue
        folder_path = Path(node.path)
        if _has_typed_ancestor(folder_path):
            continue
        try:
            entries = sorted(folder_path.glob("*.md"))
        except OSError:
            continue
        for md in entries:
            if _is_appledouble(md.name):
                continue
            try:
                if not md.is_file():
                    continue
            except OSError:
                continue
            key = str(md.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(FSRef(md, record_type=RecordType.MARKDOWN, parent=node))
    return out

# ── parse_markdown_text + id helpers (moved from MarkdownRecord) ─────────────

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
    "agents": "agent",
    "memory": "memory",
    "docs": "doc",
    "templates": "template",
}

def _markdown_id_from_path(path: Path) -> str:
    """Transitional/read-only fallback key — the stable uuid5(path) value.

    No longer the miss behavior (``markdown_gen_id`` mints a fresh v4 into the
    frontmatter capsule). Survives only as the ``parse_markdown_text`` read-side
    derive for a not-yet-stamped file.
    """
    from flow_sdk.fs_store.identifier import mint_uuid  # noqa: PLC0415
    return mint_uuid(str(path.resolve()))

def markdown_id(ref: FSRef) -> str:
    """Cheap id: adopted frontmatter capsule id; else stable derived key (no write)."""
    return adopt_or_mint_id(ref._path, write_back=False)

def markdown_gen_id(ref: FSRef) -> str:
    """Adopt the frontmatter capsule id, else mint a fresh v4 and write it back.

    Idempotent. The miss path now mints a random v4 (not uuid5(path)) so a
    shared/copied doc carries a portable id in its capsule.
    """
    return adopt_or_mint_id(ref._path, write_back=True)

def parse_markdown_text(text: str, path: Path | None = None) -> dict[str, Any]:
    """Parse a markdown string with YAML frontmatter into a fields dict.

    Public — used by ``extract_markdown`` here and by
    ``flow_sdk.fs_store.operations.markdown_index.from_markdown``.
    """
    fm_text = _extract_frontmatter(text)
    fields = _yaml_load(fm_text) if fm_text else {}
    body = _extract_body(text)

    # asset_type inference from frontmatter or parent dir name.
    asset_type = fields.get("asset_type")
    if not asset_type and path is not None:
        if path.name == "SKILL.md":
            asset_type = "skill"
        else:
            parent_name = path.parent.name if path.parent else ""
            asset_type = _DIR_TO_ASSET_TYPE.get(parent_name, "doc")
    if not asset_type:
        asset_type = "doc"

    title = fields.get("title") or (path.stem if path else "Untitled")
    tags = fields.get("tags") or []
    if isinstance(tags, str):
        tags = [t.strip() for t in tags.split(",") if t.strip()]

    links = _extract_wiki_links(body) if body else []
    links.extend(fields.get("links") or [])

    raw_id = fields.get("asset_id") or fields.get("id")
    from flow_sdk.fs_store.identifier import adopt_entity_id  # noqa: PLC0415
    # Validate-on-adopt (v4/v5 only) — a foreign/hand-authored id is never
    # adopted; derive the stable uuid5(path) instead. Keeps this read-side path
    # in agreement with ``markdown_gen_id`` (which adopts the same capsule id).
    asset_id = adopt_entity_id(raw_id)
    if not asset_id and path is not None:
        asset_id = _markdown_id_from_path(path)
    parent_id = fields.get("parent_id")
    scope = fields.get("scope") or None

    data: dict[str, Any] = {
        "asset_type": asset_type,
        "title": title,
        "tags": tags,
        "links": links,
        "body": body,
    }
    if asset_id:
        data["id"] = asset_id
    if parent_id:
        data["parent_id"] = parent_id
    if scope:
        data["scope"] = scope
    # Folder containment for the Obsidian-style wiki tree. parent_path is the
    # immediate containing directory (canonical absolute path). vault_root is
    # the scan root that owns the file.
    if path is not None:
        try:
            resolved = path.resolve()
            data["parent_path"] = str(resolved.parent)
        except OSError:
            pass
        vault = _resolve_vault_root(path)
        if vault:
            data["vault_root"] = vault
    return data

_SYSTEM_PID_CACHE: dict[str, str | None] = {}

def _resolve_system_project_id_for_path(path: Path) -> str | None:
    """Path-based fallback for stamping project_id on a markdown record
    that lives under flow_sdk/system_projects/.
    """
    try:
        from flow_sdk.config import system_projects_root  # noqa: PLC0415
    except Exception:
        return None
    try:
        sys_root = system_projects_root().resolve()
        target = path.resolve()
    except OSError:
        return None
    try:
        rel = target.relative_to(sys_root)
    except ValueError:
        return None
    if not rel.parts:
        return None
    sub_dirname = rel.parts[0]
    if sub_dirname in _SYSTEM_PID_CACHE:
        return _SYSTEM_PID_CACHE[sub_dirname]
    from flow_sdk.fs_store.indexer.roots import lookup_project_id_by_uname  # noqa: PLC0415
    pid = lookup_project_id_by_uname(sub_dirname)
    _SYSTEM_PID_CACHE[sub_dirname] = pid
    return pid

def _resolve_vault_root(path: Path) -> str | None:
    """Canonical abs path of the docs scan root that owns `path`, if any.

    Used by the extractor + by some tests. The doc search dirs themselves
    are defined in ``flow_sdk.fs_store.operations.markdown_dirs`` to keep the
    extractor module lean (avoids importing the legacy fs_records side).
    """
    from flow_sdk.fs_store.operations.markdown_dirs import doc_search_dirs  # noqa: PLC0415
    try:
        target = path.resolve()
    except OSError:
        return None
    for root in doc_search_dirs():
        try:
            target.relative_to(root)
        except ValueError:
            continue
        return str(root)
    return None

def extract_markdown(ref: FSRef) -> list[FSRecord]:
    """Parse a .md file into a Record. Replaces ``MarkdownRecord._from_fsref_sync``."""
    path = ref._path
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return []
    except UnicodeDecodeError:
        # Not real markdown — binary content under a .md extension (e.g. macOS
        # AppleDouble ``._*`` sidecars, or a mislabeled binary). Skip cleanly
        # rather than raising into the indexer's error counter.
        return []
    data = parse_markdown_text(text, path=path)
    data["type"] = RecordType.MARKDOWN
    data["status"] = "active"
    # name is the title (MarkdownRecord overrode name to read title; we
    # populate name directly so base accessors work).
    data["name"] = data.get("title") or path.stem
    # Searchable content = body + links (matches old search_content).
    body = data.get("body") or ""
    links = data.get("links") or []
    if links:
        data["content"] = (body + "\n" + " ".join(str(l) for l in links)).strip()
    else:
        data["content"] = body
    # (parent_path / vault_root are populated by parse_markdown_text already.)

    # project_id from FSRef inheritance or system-projects fallback.
    pid = getattr(ref, "project_id", None) or _resolve_system_project_id_for_path(path)
    if pid:
        data["project_id"] = pid

    rec = FSRecord(**data)
    object.__setattr__(rec, "_asset_ref", FSRef(path))
    return [rec]
