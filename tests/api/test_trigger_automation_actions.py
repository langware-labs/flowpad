"""The Automations REST surface on ``Trigger`` — status codes that say what went wrong, and
*Run once now* answering the same shape for every kind."""

from __future__ import annotations

import uuid

import pytest

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(10)]  # do not increase timeout without approval


def _name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


async def _create(client, **body) -> dict:
    resp = await client.post("/api/v1/graph/trigger/create", json={"name": _name("api-auto"), **body})
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]


async def test_create_without_a_name_is_422(bootstrapped_client):
    client = bootstrapped_client
    resp = await client.post("/api/v1/graph/trigger/create", json={"trigger_type": "tag"})
    assert resp.status_code == 422, resp.text


async def test_create_with_a_match_everything_pattern_is_422(bootstrapped_client):
    client = bootstrapped_client
    resp = await client.post("/api/v1/graph/trigger/create",
                             json={"name": _name("bad"), "trigger_type": "tag", "tag_pattern": "*"})
    assert resp.status_code == 422
    assert "EVERY event" in resp.json()["message"]


async def test_rule_code_of_an_event_rule_is_404_not_500(bootstrapped_client):
    client = bootstrapped_client
    row = await _create(client, trigger_type="tag", tag_pattern="apitest.*")
    resp = await client.get(f"/api/v1/graph/trigger/{row['id']}/trigger-content")
    assert resp.status_code == 404
    assert "no rule code" in resp.json()["message"]


async def test_run_once_on_a_disabled_event_rule_starts(bootstrapped_client):
    client = bootstrapped_client
    row = await _create(client, trigger_type="tag", tag_pattern="apitest.*", enabled=False)
    resp = await client.post(f"/api/v1/graph/trigger/{row['id']}/test",
                             json={"event": {"tag": "apitest.pick", "target": "task:t-1"}})
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["trigger_id"] == row["id"] and data["event_id"]
    assert data["detail"] == {"tag": "apitest.pick", "target": "task:t-1"}


async def test_run_once_refusal_is_422_with_the_fix(bootstrapped_client):
    client = bootstrapped_client
    row = await _create(client, trigger_type="fsop")
    resp = await client.post(f"/api/v1/graph/trigger/{row['id']}/test", json={})
    assert resp.status_code == 422
    assert "watches no file" in resp.json()["message"]


async def test_overview_lists_a_rule_as_a_sentence(bootstrapped_client):
    client = bootstrapped_client
    row = await _create(client, trigger_type="schedule", expr="0 9 * * 1-5", sched_trigger_type="cron")
    resp = await client.get("/api/v1/graph/trigger/overview")
    assert resp.status_code == 200, resp.text
    summary = next(s for s in resp.json()["data"] if s["id"] == row["id"])
    assert summary["kind"] == "schedule" and summary["group"] == "mine"
    assert summary["when"]["text"] == "Every weekday at 09:00"
    assert summary["when"]["schedule"]["preset"] == "weekdays"
    assert summary["tested"] is False and summary["last_run"] is None


async def test_next_runs_previews_an_unsaved_schedule(bootstrapped_client):
    resp = await bootstrapped_client.get("/api/v1/graph/trigger/next_runs",
                                         params={"expr": "0 9 * * 1-5", "timezone": "UTC", "n": 3})
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert len(data["times"]) == 3 and data["text"] == "Every weekday at 09:00 (UTC)"


async def test_next_runs_rejects_a_bad_expression_with_422(bootstrapped_client):
    resp = await bootstrapped_client.get("/api/v1/graph/trigger/next_runs", params={"expr": "nope"})
    assert resp.status_code == 422 and "can't be read" in resp.json()["message"]


async def test_runs_show_a_test_run_and_run_reads_it_back(bootstrapped_client):
    client = bootstrapped_client
    row = await _create(client, trigger_type="tag", tag_pattern="apiruns.*")
    await client.post(f"/api/v1/graph/trigger/{row['id']}/test", json={})
    from tests.unit.automations._helpers import settle

    await settle()
    resp = await client.get("/api/v1/graph/trigger/runs", params={"trigger_id": row["id"]})
    assert resp.status_code == 200, resp.text
    (run,) = resp.json()["data"]
    assert run["is_test"] and run["status"] == "succeeded" and run["kind"] == "event"
    one = await client.get("/api/v1/graph/trigger/run", params={"id": run["id"]})
    assert one.status_code == 200 and one.json()["data"]["id"] == run["id"]


async def test_a_missing_run_is_404(bootstrapped_client):
    resp = await bootstrapped_client.get("/api/v1/graph/trigger/run", params={"id": "no-such-run"})
    assert resp.status_code == 404
