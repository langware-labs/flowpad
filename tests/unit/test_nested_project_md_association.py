"""Nested projects — a markdown file must be associated with the DEEPEST
project whose mount contains it.

Rule (clarified 2026-07-07): association == deepest project wins. When an
umbrella folder (e.g. ``~/Flowpad workspace``) is itself a Project and a real
project (``…/sapak``) nests inside it, files under the inner mount belong to
the INNER project. Today the indexer stamps ``project_id`` from whichever
walk root reaches the file first — the umbrella root walks the inner
project's files and stamps them with the umbrella's id (see
``_resolve_scoped_roots``: one REAL_PROJECT_CWD root per project, no nested
handling; and ``real_project_cwd_fn._dedup_nested``: outermost-wins).

No mocks: real test DB + real Project rows + the real ``build_default_indexer``
walk over the exact root set the scoped ``/fs-records/index`` route builds.
"""
from __future__ import annotations

from pathlib import Path

import pytest

# Ensure MARKDOWN TypeInfo (main_subdir/extractor/owns) is registered.
import flow_sdk.fs_store.indexer.registrations  # noqa: F401

from flow_sdk.builtin.project import Project
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import IndexerOptions
from flow_sdk.fs_store.indexer.builtin import build_default_indexer
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.schema_registry import SchemaRegistry

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

MD_ID = "7c1b2a90-5d44-4f0e-9a37-1f2e3d4c5b6a"


async def _make_project(root: Path, name: str) -> Project:
    root.mkdir(parents=True, exist_ok=True)
    pid = Project.derive_id_for_path(str(root))
    proj = Project(id=pid, name=name, fs_storage_mount_path=str(root))
    await proj.save()
    return proj


async def test_md_in_nested_project_is_associated_with_inner_project(tmp_path: Path) -> None:
    # 1. Two NESTED folder projects: an umbrella workspace project and a real
    #    project inside it (the ~/Flowpad workspace / …/sapak shape).
    outer = await _make_project(tmp_path / "workspace", "workspace-umbrella")
    inner = await _make_project(tmp_path / "workspace" / "sapak", "sapak")

    md_path = tmp_path / "workspace" / "sapak" / "SPEC.md"
    md_path.write_text(
        f'---\nid: {MD_ID}\ntitle: "Spec"\n---\n# Spec\n\nnested-project association\n',
        encoding="utf-8",
    )

    # 2. Index markdown over BOTH project roots — the exact root set the scoped
    #    ``POST /fs-records/index?projects=<outer>,<inner>`` route builds via
    #    ``_resolve_scoped_roots`` (one REAL_PROJECT_CWD per project, caller
    #    order preserved; the full unscoped scan reaches the same shape through
    #    ``real_project_cwd_fn``). Umbrella first, like the production listing.
    indexer = build_default_indexer()
    await indexer.index(
        IndexerOptions(
            roots=(
                FSRef(
                    Path(outer.fs_storage_mount_path),
                    record_type=RecordType.REAL_PROJECT_CWD,
                    scope="project",
                    project_id=outer.id,
                ),
                FSRef(
                    Path(inner.fs_storage_mount_path),
                    record_type=RecordType.REAL_PROJECT_CWD,
                    scope="project",
                    project_id=inner.id,
                ),
            ),
            types=(RecordType.MARKDOWN,),
            force=True,
            verbose=False,
        )
    )

    md_cls = SchemaRegistry.get_entity_cls("markdown")
    assert md_cls is not None, "markdown entity class not registered"
    md = await md_cls.get_one({"id": MD_ID})
    assert md is not None, "index did not materialize the markdown row"

    # 3. THE RULE: deepest project wins. The file lives inside BOTH mounts, so
    #    it must be associated with the INNER project. Today the umbrella
    #    root's walk stamps it with the outer id, which is what makes opening
    #    the doc auto-switch the active project away from its real project.
    assert md.project_id == inner.id, (
        f"markdown in nested project associated with the wrong project: "
        f"got {md.project_id!r} (outer={outer.id!r}), expected inner {inner.id!r}"
    )
