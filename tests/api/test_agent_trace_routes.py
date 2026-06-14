"""Worker agent-trace routes: GET trace-skeleton + POST agent-trace (create record)."""

import json

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from flow_sdk.server.app import app

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

SID = "22222222-2222-4222-8222-222222222222"


def _user(uuid_, ts, text):
    return {
        "type": "user", "uuid": uuid_, "sessionId": SID, "timestamp": ts,
        "message": {"role": "user", "content": [{"type": "text", "text": text}]},
    }


def _tool_use(uuid_, ts, tuid, name, tool_input):
    return {
        "type": "assistant", "uuid": uuid_, "sessionId": SID, "timestamp": ts,
        "message": {"id": f"m-{uuid_}", "model": "claude",
                    "content": [{"type": "tool_use", "id": tuid, "name": name,
                                 "input": tool_input}]},
    }


@pytest.fixture()
def session_on_disk(tmp_path, monkeypatch):
    proj = tmp_path / ".claude" / "projects" / "-tmp-proj"
    proj.mkdir(parents=True)
    lines = [
        _user("u1", "2026-06-12T10:00:00Z", "do the thing"),
        _tool_use("a1", "2026-06-12T10:00:10Z", "tu1", "Bash", {"command": "echo hi"}),
    ]
    (proj / f"{SID}.jsonl").write_text(
        "\n".join(json.dumps(line) for line in lines) + "\n", encoding="utf-8")
    monkeypatch.setattr(
        "flow_sdk.transcript_analyzer.resolver._claude_projects_dir",
        lambda: tmp_path / ".claude" / "projects",
    )
    return proj


@pytest_asyncio.fixture()
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def test_trace_skeleton_route(client, session_on_disk):
    r = await client.get(f"/api/v1/workers/claude/{SID}/trace-skeleton")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    skeleton = body["skeleton"]
    assert skeleton["session_id"] == SID
    assert skeleton["summary"]["lane_count"] == 1
    assert skeleton["lanes"][0]["segments"][0]["label"] == "do the thing"
    # Schema v2: the call-stack tree is part of the report.
    assert skeleton["version"] == 2
    assert skeleton["call_tree"]["kind"] == "session"


async def test_trace_skeleton_unknown_session(client, session_on_disk):
    r = await client.get("/api/v1/workers/claude/99999999-9999-4999-8999-999999999999/trace-skeleton")
    assert r.status_code == 404


async def test_create_agent_trace_route_creates_new_records(client, session_on_disk):
    annotations = {
        "verdict": "ok",
        "verdict_reason": "clean run",
        "goals": [{"label": "do the thing", "lane_id": "root",
                   "start_ts": "2026-06-12T10:00:00Z"}],
        "issues": [{"ts": "2026-06-12T10:00:10Z", "label": "judged issue",
                    "severity": "attention"}],
    }
    r1 = await client.post(f"/api/v1/workers/claude/{SID}/agent-trace",
                           json={"annotations": annotations})
    assert r1.status_code == 200, r1.text
    body1 = r1.json()
    assert body1["ok"] is True
    assert body1["summary"]["verdict"] == "ok"
    assert body1["summary"]["issue_count"] == 1
    assert body1["id"]

    # Rerun adds a NEW record — history, never overwrite.
    r2 = await client.post(f"/api/v1/workers/claude/{SID}/agent-trace",
                           json={"annotations": annotations})
    assert r2.status_code == 200
    assert r2.json()["id"] != body1["id"]

    # The summary fields are queryable via the graph API; trace stays a blob.
    g = await client.get(f"/api/v1/graph/agent_trace/{body1['id']}")
    assert g.status_code == 200
    data = g.json()["data"]
    assert data["verdict"] == "ok"
    assert data["session_id"] == SID
    assert not data.get("trace")
