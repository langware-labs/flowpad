"""Walker + extractor + helpers for MARKDOWN records.

Discovery has two halves:
  the declared ``walk`` (``markdown_type_info.py``)
      rglob <root>/docs/**/*.md — the DOCS family mount, on USER_HOME_FOLDER
      only, run by the generic ``layout_walker``. It is what makes user-scope
      markdown discoverable AT ALL: ``markdown_in_folder_fn`` runs off FOLDER
      refs, which ``project_folder_walker_fn`` emits for project roots only —
      ``~/`` is deliberately never content-walked (a huge tree full of venvs
      and npm packages). One bounded directory is the whole point; do not
      widen it to a tree walk of home.

  markdown_in_folder_fn (bespoke, below)
      Per-FOLDER emitter. Receives FOLDER refs from
      ``project_folder_walker_fn`` (which already pruned via gitignore +
      _WALK_IGNORED) and emits the direct ``*.md`` children of every
      walked folder. Register on FOLDER. Gitignore is the only filter —
      every ``.md`` in a project (or system project) is indexed.

``parse_markdown_text`` is exported so other consumers (e.g.
``extract_markdown_index``) can share the frontmatter+body parse.
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.assets.placement import AGENTIC_ASSETS_DIR
from flow_sdk.assets.scanning import first_seen, is_appledouble
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


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

    Kept BESPOKE (not a declared ``Walk``): the typed-ancestor fence and the
    by-name skill-doc skip are cross-type rules — "every ``.md`` a different
    type's walk already claims" — that a per-type declaration cannot state.
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
            if is_appledouble(md.name):
                continue
            # SKILL.md / skill.md is a skill's doc (claimed by the skill walk),
            # never a standalone MARKDOWN asset — skip so it isn't double-indexed.
            if md.name.lower() == "skill.md":
                continue
            try:
                if not md.is_file():
                    continue
            except OSError:
                continue
            if first_seen(seen, md, resolve=True):
                out.append(FSRef(md, record_type=RecordType.MARKDOWN, parent=node))
    return out


# ── parse_markdown_text + id helpers (moved from MarkdownRecord) ─────────────


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


def derive_markdown_context(data: dict, root: Path, header_raw: dict) -> None:
    vault = _resolve_vault_root(root)
    if vault:
        data["vault_root"] = vault
    if not data.get("project_id"):
        pid = _resolve_system_project_id_for_path(root)
        if pid:
            data["project_id"] = pid
