"""HTTP integration test for the git-ops per-file revision route.

Drives the REAL stack — TestClient → graph route → ComputeNode.git_ops_action →
GitRepo.dispatch → git — against a temp git repo, proving the ``file`` query
parameter reaches dispatch and the revision list comes back over HTTP. This is
the end-to-end proof of the Stage-3 route (the piece a stale dev backend made
look like it 404'd / dropped params).
"""

import subprocess
import uuid

import pytest
from starlette.testclient import TestClient

pytestmark = pytest.mark.usefixtures("reset_db_for_testclient")


def _git(args, cwd):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


def _make_repo(tmp_path):
    repo = tmp_path / f"repo-{uuid.uuid4().hex[:8]}"
    repo.mkdir()
    _git(["init"], repo)
    _git(["config", "user.email", "t@t.test"], repo)
    _git(["config", "user.name", "t"], repo)
    for v, body in [(1, "Body one."), (2, "Body two.")]:
        (repo / "SKILL.md").write_text(
            f"---\nname: slick\nversion: {v}\n---\n\n# slick\n\n{body}\n", encoding="utf-8"
        )
        _git(["add", "-A"], repo)
        _git(["commit", "-m", f"Flowpad: slick v{v}"], repo)
    return repo


@pytest.mark.asyncio
async def test_file_revisions_over_http(tmp_path):
    from flow_sdk.db.database import init_db
    from flow_sdk.server.app import app
    from flow_sdk.server.routes.bootstrap import get_or_create_local_compute_node

    await init_db()
    await get_or_create_local_compute_node()  # ensure @local resolves
    repo = _make_repo(tmp_path)

    with TestClient(app) as client:
        resp = client.get(
            "/api/v1/graph/compute_node/@local/git-ops/file-revisions",
            params={"workdir": str(repo), "file": "SKILL.md"},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        revisions = data["revisions"]
        assert len(revisions) == 2
        assert [r["version"] for r in revisions] == [2, 1]  # newest first
        assert data["version"] == 2
        assert "v2" in revisions[0]["message"]
        assert revisions[0]["hash"]


@pytest.mark.asyncio
async def test_revision_diff_over_http(tmp_path):
    from flow_sdk.db.database import init_db
    from flow_sdk.server.app import app
    from flow_sdk.server.routes.bootstrap import get_or_create_local_compute_node

    await init_db()
    await get_or_create_local_compute_node()  # ensure @local resolves
    repo = _make_repo(tmp_path)
    head = subprocess.run(
        ["git", "rev-list", "--max-parents=0", "HEAD"], cwd=repo, capture_output=True, text=True
    ).stdout.strip()  # the v1 (root) commit

    with TestClient(app) as client:
        resp = client.get(
            "/api/v1/graph/compute_node/@local/git-ops/revision-diff",
            params={"workdir": str(repo), "file": "SKILL.md", "hash": head},
        )
        assert resp.status_code == 200, resp.text
        diff = resp.json()["data"]["diff"]
        assert "Body one." in diff and "Body two." in diff
