"""Walkers + extractor + helpers for MARKDOWN records.

Walkers:
  markdown_flat_fn
      rglob <root>/docs/**/*.md — the DOCS family mount.
      Register on USER_HOME_FOLDER only, and note this walker is what makes
      user-scope markdown discoverable AT ALL: ``markdown_in_folder_fn`` runs off
      FOLDER refs, which ``project_folder_walker_fn`` emits for project roots
      only — ``~/`` is deliberately never content-walked (a huge tree full of
      venvs and npm packages). One bounded directory is the whole point; do not
      widen this to a tree walk of home.

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

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer._frontmatter import (
    _extract_body,
    _extract_frontmatter,
    _yaml_load,
)
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.placement import AGENTIC_ASSETS_DIR
from flow_sdk.fs_store.record_types import RecordType


def _is_appledouble(name: str) -> bool:
    """True for macOS AppleDouble sidecars (``._foo.md``) — binary
    resource-fork files that share a ``.md`` extension but never hold real
    markdown. Indexing them only raises a UnicodeDecodeError downstream."""
    return name.startswith("._")


def _emit_md_rglob(
    root: Path,
    parent: FSRef,
    out: list[FSRef],
    seen: set[str],
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
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    """``<root>/docs/**/*.md`` — the DOCS family mount, one bounded directory.

    Was ``<root>/.claude/docs`` until markdown became ``AssetClass.DOCS``. That
    directory was flowpad's own invention, not part of Claude Code's vocabulary,
    and it split markdown across two homes: created docs went to ``docs/`` while
    received ones went to ``.claude/docs/``.
    """
    from flow_sdk.fs_store.placement import DOCS_FAMILY  # noqa: PLC0415

    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        _emit_md_rglob(Path(node.path) / DOCS_FAMILY, node, out, seen)
    return out


def _typed_record_dirs() -> frozenset[str]:
    """Directory names whose ``.md`` children a typed indexer already claims.

    Both halves are DERIVED, never hand-listed:
      * harness families (``skills``, ``agents``, ``commands``, ``rules``,
        ``workflows``) from ``SchemaRegistry.harness_scoped_families()``;
      * ``agentic-assets`` — one segment covering every REPO type at any depth,
        since ``repo_assets_fn`` claims that whole hierarchy.

    Hand-listing is what rotted this check twice over: the set still named
    ``whiteboards``/``task`` long after spec, deck, dataset and deck_template had
    moved, and it never named ``rules`` at all — so those main docs were being
    double-indexed as both their own type and MARKDOWN. Deriving means a new type
    enrolls by declaring its ``asset_class``, with no edit here.
    """
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    return SchemaRegistry.harness_scoped_families() | {AGENTIC_ASSETS_DIR}


def _has_typed_ancestor(folder: Path, typed_dirs: frozenset[str] | None = None) -> bool:
    """True if ``folder`` itself or any ancestor is a typed-record dir.

    ``typed_dirs`` is hoisted by the per-scan caller so the registry query runs
    once per walk rather than once per folder.
    """
    typed = _typed_record_dirs() if typed_dirs is None else typed_dirs
    p = folder
    while True:
        if p.name in typed:
            return True
        if p.parent == p:
            return False
        p = p.parent


def markdown_in_folder_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    """For each walked FOLDER, emit its direct ``*.md`` children.

    The walker already descended every subdirectory and filtered via
    gitignore + ``_WALK_IGNORED``; this function only emits — no glob
    recursion needed (use ``glob`` not ``rglob``).

    Folders under a typed-record dir (see ``_typed_record_dirs``) are skipped so
    a SKILL.md / agent .md / rules .md isn't double-indexed as MARKDOWN.
    """
    out: list[FSRef] = []
    seen: set[str] = set()
    typed_dirs = _typed_record_dirs()
    for node in nodes:
        if node.record_type != RecordType.FOLDER:
            continue
        folder_path = Path(node.path)
        if _has_typed_ancestor(folder_path, typed_dirs):
            continue
        try:
            entries = sorted(folder_path.glob("*.md"))
        except OSError:
            continue
        for md in entries:
            if _is_appledouble(md.name):
                continue
            # SKILL.md / skill.md is a skill's doc (claimed by skill_in_folder_fn),
            # never a standalone MARKDOWN asset — skip so it isn't double-indexed.
            if md.name.lower() == "skill.md":
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
    "agents": "subagent",
    "memory": "memory",
    "docs": "doc",
    "templates": "template",
}


def _markdown_id_from_path(path: Path) -> str:
    """Transitional/read-only fallback key — the stable uuid5(path) value.

    No longer the miss behavior (``TypeInfo.mint_id`` persists a fresh v4).
    Survives only as the ``parse_markdown_text`` read-side
    derive for a not-yet-stamped file.
    """
    from flow_sdk.fs_store.identifier import mint_uuid  # noqa: PLC0415

    return mint_uuid(str(path.resolve()))


def markdown_id(ref: FSRef) -> str:
    """The id the indexer would assign, derived WITHOUT writing.

    Routes through the one seam. It used to read frontmatter only, while the
    indexer's backend reads the identity CAPSULE first — so a capsule-stamped,
    frontmatter-less doc got a different id here than from the walk, and this
    value feeds straight into ``sync_to_db()`` (agentic_process, bootstrap).
    That forked the document; delegating converges it.

    ``overwrite=False`` keeps the no-write contract: these callers run in
    request handlers and over read-only mounts.
    """
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    info = SchemaRegistry.get(str(RecordType.MARKDOWN))
    if info is None:
        # Deliberately no fallback. The only fallback available is the
        # frontmatter-only derive this function was rewired to eliminate, and
        # its result flows into sync_to_db() — a crash during registry
        # bootstrap is strictly better than a silently forked document.
        raise RuntimeError("markdown TypeInfo is not registered; cannot resolve identity")
    return info.mint_entity_id(ref, derive=True, overwrite=False)


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
    vault = _resolve_vault_root(root)
    if vault:
        data["vault_root"] = vault
    if not data.get("project_id"):
        pid = _resolve_system_project_id_for_path(root)
        if pid:
            data["project_id"] = pid


def derive_markdown(data: dict, root: Path, header_raw: dict) -> None:
    _derive(data, root, header_raw, titled=True)


def derive_claude_md(data: dict, root: Path, header_raw: dict) -> None:
    _derive(data, root, header_raw, titled=False)


def parse_markdown_text(text: str, path: Path | None = None) -> dict[str, Any]:
    """Parse a markdown string with YAML frontmatter into a fields dict — the
    same header (``MarkdownSpec``) and the same derivation the serializer
    applies, over a STRING. Public for ``operations.markdown_index.from_markdown``."""
    from flow_sdk.builtin.claude_memory_entities import MarkdownSpec  # noqa: PLC0415
    from flow_sdk.capsules import strip_capsule_blocks  # noqa: PLC0415
    from flow_sdk.fs_store.identifier import adopt_entity_id  # noqa: PLC0415

    text = strip_capsule_blocks(text)
    fm_text = _extract_frontmatter(text)
    fields = _yaml_load(fm_text) if fm_text else {}
    fields = fields if isinstance(fields, dict) else {}
    data: dict[str, Any] = MarkdownSpec.model_validate(fields).model_dump(exclude_none=True, exclude={"body"})
    data["body"] = _extract_body(text)
    _derive(data, path or Path("Untitled.md"), fields, titled=True)
    # Validate-on-adopt (v4/v5 only) — a foreign/hand-authored id is never
    # adopted; derive the stable uuid5(path) instead.
    asset_id = adopt_entity_id(fields.get("asset_id") or fields.get("id"))
    if not asset_id and path is not None:
        asset_id = _markdown_id_from_path(path)
    if asset_id:
        data["id"] = asset_id
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
