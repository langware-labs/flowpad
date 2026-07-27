"""orphan_action=delete must not false-orphan live project records.

Regression for the prod incident where a single
``POST /fs-records/index?orphan_action=delete`` deleted live project markdown
rows (sapora 25→0). Root cause: the handler set ``custom_roots = None`` for any
non-INDEX orphan action, and ``default_roots()`` does NOT descend the registered
project file trees — so every project record went "unseen" and was flagged a
false orphan. The fix resolves the full all-projects root set for orphan runs so
``seen_ids`` is global; a live record whose project tree exists must survive.
"""

from __future__ import annotations

import pytest

from flow_sdk.fs_store import get_default_records_root, set_default_records_root


@pytest.fixture(autouse=True)
def isolate_records_root(tmp_path, monkeypatch):
    from flow_sdk.fs_store.indexer import reset_shared_indexer
    from flow_sdk.instance_settings import reset_instance_settings
    original = get_default_records_root()
    records_root = tmp_path / "records"
    records_root.mkdir()
    set_default_records_root(records_root)
    fake_home = tmp_path / "_home"
    fake_home.mkdir()
    monkeypatch.setenv("HOME", str(fake_home))
    monkeypatch.setenv("USERPROFILE", str(fake_home))
    monkeypatch.setenv("FLOW_INSTANCE", "test")
    monkeypatch.setenv("FLOWPAD_TEST_SANDBOX", str(fake_home))
    reset_instance_settings()
    reset_shared_indexer()
    yield tmp_path
    set_default_records_root(original)
    reset_instance_settings()
    reset_shared_indexer()


def _cn_url(boot: dict, sub: str) -> str:
    cn_id = boot["data"]["default_compute_node"]["id"]
    return f"/api/v1/graph/compute_node/{cn_id}/fs-records/{sub}"


async def _markdown_total(client, boot, project_id: str) -> int:
    cn_id = boot["data"]["default_compute_node"]["id"]
    # Filter-only browse ``total`` is the post-limit, post-scope-filter result
    # count — NOT a global COUNT(*). Under the session-shared DB other tests'
    # markdown rows are present, so a small limit would browse rows outside this
    # project and the scope filter would drop them, undercounting projA. Use a
    # limit large enough to include projA's row in the browsed page.
    resp = await client.get(
        f"/api/v1/graph/compute_node/{cn_id}/fs-records/search"
        f"?record_type=markdown&projects={project_id}&user=false&limit=500"
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]["total"]


@pytest.mark.asyncio
async def test_orphan_delete_keeps_live_project_markdown(bootstrapped_client, tmp_path, monkeypatch):
    from flow_sdk.builtin.project import Project
    from flow_sdk.fs_store.operations import all_projects as _ap
    from flow_sdk.fs_store.operations.all_projects import invalidate_projects_cache

    # pytest's tmp_path lives under the OS temp dir, which get_all_projects
    # filters out through the canonical project-cwd policy — a real workspace
    # isn't temp. Treat the test project as a normal path so the global orphan
    # walk includes it.
    monkeypatch.setattr(_ap, "is_valid_project_cwd", lambda *_a, **_k: True)

    # A real project tree (sibling of records_root / fake_home) with one live md.
    proj_dir = tmp_path / "workspace" / "projA"
    proj_dir.mkdir(parents=True)
    (proj_dir / "doc.md").write_text("# live doc\n\nbody\n", encoding="utf-8")

    # Register the project so get_all_scope_filter resolves its REAL_PROJECT_CWD root.
    proj = Project.model_validate({"fs_storage_mount_path": str(proj_dir), "name": "projA"})
    proj.id = Project.allocate_id(proj.model_dump())
    await proj.save()
    invalidate_projects_cache()
    pid = proj.id

    boot = (await bootstrapped_client.get("/api/v1/graph/bootstrap")).json()
    index_url = _cn_url(boot, "index")

    # Index the project's markdown → row created.
    r = await bootstrapped_client.post(f"{index_url}?type=markdown&projects={pid}&user=false&force=true")
    assert r.status_code == 200, r.text
    assert await _markdown_total(bootstrapped_client, boot, pid) == 1

    # The destructive orphan sweep, scoped to this project. The source file is
    # present → it is NOT an orphan → it must survive. Pre-fix (default_roots
    # walk never descended projA) it was false-orphaned and deleted.
    r2 = await bootstrapped_client.post(
        f"{index_url}?type=markdown&projects={pid}&user=false&orphan_action=delete"
    )
    assert r2.status_code == 200, r2.text
    # A project-scoped orphan sweep must touch ONLY projA-scoped orphans. projA's
    # doc.md is on disk (not an orphan) → orphans_db_removed must be 0 even when
    # the shared DB carries unscoped orphans from sibling tests (a None-scope row
    # of a scoped type is out of any project scope; see _scope_filtered_orphans).
    assert r2.json()["data"]["orphans_db_removed"] == 0, (
        f"live record false-orphaned: {r2.json()['data']}"
    )
    assert await _markdown_total(bootstrapped_client, boot, pid) == 1, (
        "live project markdown was deleted by orphan_action=delete"
    )
