"""End-to-end backend contract behind the terminal Analysis side-window's
Improve → diff → version flow. Real HTTP (TestClient) + real git, no mocks.

Two halves, both over the live stack:
  1. An analysis (AgentTrace) created from skill-attributed annotations carries
     per-skill findings — the source the panel enumerates as "improvable skills"
     and counts in the issue badge.
  2. A skill improvement edited in place is reviewable (HEAD-vs-worktree diff),
     acceptable (commit-asset → version bump), and rejectable (discard-file →
     restored) — the modal's Reject / Save & create version actions.
"""

import json
import subprocess
import uuid
from pathlib import Path

import pytest
from starlette.testclient import TestClient

pytestmark = [
    pytest.mark.usefixtures("reset_db_for_testclient"),
    pytest.mark.asyncio,
    pytest.mark.timeout(30),  # do not increase timeout without approval
]

SID = "33333333-3333-4333-8333-333333333333"
SKILL = "slick-demo"

# An issue the analysis attributed to SKILL — the backend projects it into
# `annotations.by_skill[SKILL].findings`, which the panel reads to offer Improve.
ANNOTATIONS = {
    "verdict": "mixed",
    "verdict_reason": "ran Bash where the skill says use Read",
    "issues": [
        {
            "ts": "2026-06-12T10:00:10Z",
            "label": "used Bash instead of Read",
            "detail": "the skill instructs reading files, not shelling out",
            "severity": "attention",
            "skill": SKILL,
            "section_hint": "Investigate then act.",
            "evidence": {"quote": "echo hi", "ts": "2026-06-12T10:00:10Z"},
        }
    ],
}


def _git(args, cwd):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


def _transcript_dir(tmp_path, monkeypatch):
    """A minimal claude session jsonl on disk, resolvable by the analyzer."""
    proj = tmp_path / ".claude" / "projects" / "-tmp-proj"
    proj.mkdir(parents=True)
    lines = [
        {"type": "user", "uuid": "u1", "sessionId": SID, "timestamp": "2026-06-12T10:00:00Z",
         "message": {"role": "user", "content": [{"type": "text", "text": "do the thing"}]}},
        {"type": "assistant", "uuid": "a1", "sessionId": SID, "timestamp": "2026-06-12T10:00:10Z",
         "message": {"id": "m1", "model": "claude",
                     "content": [{"type": "tool_use", "id": "tu1", "name": "Bash",
                                  "input": {"command": "echo hi"}}]}},
    ]
    (proj / f"{SID}.jsonl").write_text("\n".join(json.dumps(x) for x in lines) + "\n", "utf-8")
    monkeypatch.setattr(
        "flow_sdk.transcript_analyzer.resolver._claude_projects_dir",
        lambda: tmp_path / ".claude" / "projects",
    )


def _skill_repo(tmp_path):
    """A committed skill (SKILL.md v1) in its own git repo — the improvable asset."""
    repo = tmp_path / f"skill-{uuid.uuid4().hex[:8]}"
    repo.mkdir()
    _git(["init"], repo)
    _git(["config", "user.email", "t@t.test"], repo)
    _git(["config", "user.name", "t"], repo)
    (repo / "SKILL.md").write_text(
        f"---\nid: 9fe9bee3-ce84-58c1-b047-90629fa5dfd3\nname: {SKILL}\nversion: 1\n---\n\n"
        "# slick-demo\n\nInvestigate then act.\n",
        "utf-8",
    )
    _git(["add", "-A"], repo)
    _git(["commit", "-m", f"Flowpad: {SKILL} v1"], repo)
    return repo


async def test_analysis_carries_per_skill_findings(tmp_path, monkeypatch):
    from flow_sdk.db.database import init_db
    from flow_sdk.server.app import app

    await init_db()
    _transcript_dir(tmp_path, monkeypatch)

    with TestClient(app) as client:
        r = client.post(f"/api/v1/workers/claude/{SID}/agent-trace",
                        json={"annotations": ANNOTATIONS})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True
        assert body["summary"]["issue_count"] >= 1  # drives the row's issue badge
        assert body["id"]

    # Read the SAME trace.json the panel consumes via FSRef (asset_ref under the
    # @local node root = home) — assert the per-skill projection it offers Improve from.
    trace_doc = json.loads((Path.home() / body["asset_ref"]).read_text())
    by_skill = trace_doc["annotations"]["by_skill"]
    assert SKILL in by_skill
    assert by_skill[SKILL]["findings"], "skill finding must survive into by_skill"


async def test_improvement_diff_accept_then_reject(tmp_path):
    from flow_sdk.db.database import init_db
    from flow_sdk.server.app import app
    from flow_sdk.server.routes.bootstrap import get_or_create_local_compute_node

    await init_db()
    await get_or_create_local_compute_node()  # ensure @local resolves
    repo = _skill_repo(tmp_path)
    md = repo / "SKILL.md"
    params = {"workdir": str(repo), "file": "SKILL.md"}

    with TestClient(app) as client:
        # skillit edits the skill in place (the "improvement").
        md.write_text(md.read_text().replace("Investigate then act.", "Investigate, then act carefully."), "utf-8")

        # Improvement results: HEAD-vs-worktree diff shows the fix (the `diff`
        # subpath = `git diff HEAD -- file`; `revision-diff` is committed-only).
        diff = client.get("/api/v1/graph/compute_node/@local/git-ops/diff",
                          params={**params, "status": "M"})
        assert diff.status_code == 200, diff.text
        body = diff.json()["data"]["diff"]
        assert "+Investigate, then act carefully." in body and "-Investigate then act." in body

        # Save & create version: commit + frontmatter version bump.
        commit = client.post("/api/v1/graph/compute_node/@local/commit-asset", json=params)
        assert commit.status_code == 200, commit.text
        cdata = commit.json()["data"]
        assert cdata["committed"] is True and cdata["version"] == 2
        assert "version: 2" in md.read_text()

        # Reject: a second edit, then discard restores the committed (v2) version.
        md.write_text(md.read_text().replace("carefully.", "RECKLESSLY."), "utf-8")
        discard = client.post("/api/v1/graph/compute_node/@local/git-ops/discard-file",
                              params={**params, "status": "M"})
        assert discard.status_code == 200, discard.text
        assert discard.json()["data"]["ok"] is True
        restored = md.read_text()
        assert "RECKLESSLY." not in restored and "Investigate, then act carefully." in restored
