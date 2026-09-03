"""Full analysis flow — HTTP integration layer (real TestClient + real git, no mocks).

Drives the whole loop the user defined, over the live stack, with the agentic
steps seeded for determinism (the browser layer runs them for real):

  scaffold product-finder skill (from the shared fixture, git v1)
   → fabricate a skill-loaded session transcript
   → assert the skill shows as loaded (transcript route + trace-skeleton event)
   → LOOP up to 3 cycles: analyze (agent-trace, by_skill finding) → improve
     (simulated in-place edit) → diff (git-ops) → Save & version (commit-asset),
     re-analyzing each round and stopping when an analysis is clean OR at 3 cycles.

Mirrors `shouldRunAnotherCycle` (analysis-improvements.ts) as the driver's stop rule.
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

SID = "44444444-4444-4444-8444-444444444444"
SKILL = "product-finder"
MAX_CYCLES = 3
FIXTURE = Path(__file__).parents[1] / "fixtures" / "product-finder" / "SKILL.md"


def _git(args, cwd):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


def _skill_repo(tmp_path) -> Path:
    """Scaffold the product-finder skill from the shared fixture, committed at v1."""
    repo = tmp_path / f"proj-{uuid.uuid4().hex[:8]}"
    skill_dir = repo / ".claude" / "skills" / SKILL
    skill_dir.mkdir(parents=True)
    _git(["init"], repo)
    _git(["config", "user.email", "t@t.test"], repo)
    _git(["config", "user.name", "t"], repo)
    (skill_dir / "SKILL.md").write_text(FIXTURE.read_text(), encoding="utf-8")
    _git(["add", "-A"], repo)
    _git(["commit", "-m", f"Flowpad: {SKILL} v1"], repo)
    return skill_dir


def _skill_loaded_transcript(tmp_path, monkeypatch):
    """A session where the product-finder skill was loaded + a smartphone search ran."""
    proj = tmp_path / ".claude" / "projects" / "-tmp-proj"
    proj.mkdir(parents=True)
    lines = [
        {"type": "user", "uuid": "u1", "sessionId": SID, "timestamp": "2026-06-25T10:00:00Z",
         "message": {"role": "user", "content": [{"type": "text", "text": "search for smartphone"}]}},
        {"type": "assistant", "uuid": "a1", "sessionId": SID, "timestamp": "2026-06-25T10:00:05Z",
         "message": {"id": "m1", "model": "claude",
                     "content": [{"type": "tool_use", "id": "tu1", "name": "Skill",
                                  "input": {"skill": SKILL}}]}},
        {"type": "user", "uuid": "u2", "sessionId": SID, "timestamp": "2026-06-25T10:00:06Z",
         "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "tu1", "content": "loaded"}]}},
        {"type": "assistant", "uuid": "a2", "sessionId": SID, "timestamp": "2026-06-25T10:00:10Z",
         "message": {"id": "m2", "model": "claude",
                     "content": [{"type": "tool_use", "id": "tu2", "name": "Bash", "input": {"command": "curl shop"}}]}},
    ]
    (proj / f"{SID}.jsonl").write_text("\n".join(json.dumps(x) for x in lines) + "\n", "utf-8")
    monkeypatch.setattr(
        "flow_sdk.transcript_analyzer.resolver._claude_projects_dir",
        lambda: tmp_path / ".claude" / "projects",
    )


def _annotations(found: bool):
    """A by_skill finding while the skill is imperfect; clean once it converges."""
    if not found:
        return {"verdict": "ok", "verdict_reason": "skill is solid"}
    return {
        "verdict": "mixed", "verdict_reason": "missed a step",
        "issues": [{"ts": "2026-06-25T10:00:10Z", "label": "did not honor price range",
                    "severity": "attention", "skill": SKILL, "section_hint": "Search online",
                    "evidence": {"quote": "curl shop", "ts": "2026-06-25T10:00:10Z"}}],
    }


async def test_full_analysis_flow_loop(tmp_path, monkeypatch):
    from flow_sdk.db.database import init_db
    from flow_sdk.server.app import app
    from flow_sdk.server.routes.bootstrap import get_or_create_local_compute_node

    await init_db()
    await get_or_create_local_compute_node()
    skill_dir = _skill_repo(tmp_path)
    skill_md = skill_dir / "SKILL.md"
    params = {"workdir": str(skill_dir), "file": "SKILL.md"}
    _skill_loaded_transcript(tmp_path, monkeypatch)

    with TestClient(app) as client:
        # Step 4 — the skill is loaded and visible to the Skills & Agents panel
        # (which reads this transcript route → SkillCallEntry).
        tr = client.get(f"/api/v1/workers/claude/{SID}/transcript")
        assert tr.status_code == 200, tr.text
        loaded = [e for e in tr.json()["data"]["entries"] if e.get("kind") == "skill_call"]
        assert any(e.get("skill_name") == SKILL for e in loaded), "product-finder must show as loaded"
        # …and the deterministic skeleton records the skill_load event.
        sk = client.get(f"/api/v1/workers/claude/{SID}/trace-skeleton")
        assert sk.status_code == 200, sk.text
        skeleton = sk.json()["data"]["skeleton"]
        assert any(e["kind"] == "skill_load" and e["label"] == SKILL for e in skeleton["events"])
        # Value substrate: the backend emits what the projected-savings layer consumes —
        # per-run cost in the summary and per-segment cost/severity in the lanes.
        assert "cost_usd" in skeleton["summary"] and "duration_ms" in skeleton["summary"]
        segs = [s for lane in skeleton["lanes"] for s in lane.get("segments", [])]
        assert segs and all("cost_usd" in s and "severity" in s for s in segs)

        # Steps 5–9 — the analyze → improve → version loop. "Converges" on cycle 3
        # (clean analysis) to exercise the no-more-improvements stop before the cap.
        cycles_run = 0
        for cycle in range(MAX_CYCLES + 2):  # headroom; the stop rule must end it
            # Two imperfect analyses, then a clean one → exercises the converge stop.
            ann = client.post(f"/api/v1/workers/claude/{SID}/agent-trace",
                              json={"annotations": _annotations(cycle < 2)})
            assert ann.status_code == 200, ann.text
            improvable = ann.json()["data"]["summary"]["issue_count"] > 0

            # Stop rule (mirror of shouldRunAnotherCycle): cap OR converged.
            if cycles_run >= MAX_CYCLES or not improvable:
                break

            # Improve (seeded skillit edit) → diff shows it → Save & create version.
            skill_md.write_text(
                skill_md.read_text().replace("Search online", f"Search online (refined v{cycles_run + 2})"), "utf-8")
            diff = client.get("/api/v1/graph/compute_node/@local/git-ops/diff", params={**params, "status": "M"})
            assert diff.status_code == 200 and "refined" in diff.json()["data"]["diff"]
            commit = client.post("/api/v1/graph/compute_node/@local/commit-asset", json=params)
            assert commit.status_code == 200, commit.text
            cycles_run += 1
            assert commit.json()["data"]["version"] == cycles_run + 1  # v1 → v2 → v3

        assert 1 <= cycles_run <= MAX_CYCLES
        # Converged before the cap (clean analysis on cycle 3), so 2 improvements landed.
        assert cycles_run == 2
        head = subprocess.run(["git", "log", "--oneline"], cwd=skill_dir, capture_output=True, text=True).stdout
        assert head.count("product-finder v") >= 3  # v1 scaffold + v2 + v3
