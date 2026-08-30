"""LIVE: the data-integrations persona takes a fresh project from no source to a
streaming source with a dataset and one gold label — driven by a real Claude
worker over the API, judged on ARTIFACTS only (rows on disk and in the DB),
never on the agent's words.

Budget: 600 s (approved 2026-08-30 — three agent turns + one ≤60 s heartbeat).
NEVER raised. Skips without a real Claude (`CLAUDE_HOME`) like its siblings.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from datetime import datetime, timezone

import httpx
import pytest

from tests.unit._ingest_helpers import local_http_server

pytestmark = [
    pytest.mark.asyncio,
    pytest.mark.timeout(600),  # approved budget — do not raise
    pytest.mark.skipif(not os.environ.get("FLOWPAD_CLAUDE_HOME"), reason="needs a real Claude (FLOWPAD_CLAUDE_HOME=$HOME/.claude)"),
]

BASE = os.environ.get("QA_API_URL") or f"http://127.0.0.1:{os.environ.get('LOCAL_SERVER_PORT', '9007')}"


def _atom() -> bytes:
    now = datetime.now(timezone.utc)
    entries = "".join(
        f"<entry><id>urn:live:{i}</id><title>Live entry {i}</title><updated>{now.isoformat()}</updated>"
        f"<content type='text'>body {i} zebrafish</content><link href='http://127.0.0.1/e/{i}'/></entry>"
        for i in range(1, 4)
    )
    return f"<?xml version='1.0'?><feed xmlns='http://www.w3.org/2005/Atom'><title>live</title><updated>{now.isoformat()}</updated>{entries}</feed>".encode()


async def _data(client: httpx.AsyncClient, method: str, path: str, **kw):
    resp = await client.request(method, path, **kw)
    body = resp.json()
    assert body.get("status") == "SUCCESS", (path, resp.text[:300])
    return body["data"]


async def _until(predicate, *, budget_s: float, every_s: float = 10.0):
    """Sample until ``predicate()`` returns a truthy value or the budget is spent."""
    deadline = time.monotonic() + budget_s
    while True:
        value = await predicate()
        if value:
            return value
        if time.monotonic() >= deadline:
            return None
        await asyncio.sleep(every_s)


async def test_persona_connects_samples_and_defines(tmp_path):
    async with httpx.AsyncClient(base_url=BASE, timeout=httpx.Timeout(10.0, read=60.0)) as client:
        try:
            await client.get("/api/v1/graph/bootstrap")
        except httpx.HTTPError:
            pytest.skip(f"no backend at {BASE}")

        with local_http_server(lambda _p, _h: (200, _atom(), {"Content-Type": "application/atom+xml"})) as feed:
            project = await _data(client, "POST", "/api/v1/graph/project",
                                  json={"type": "project", "name": tmp_path.name, "fs_storage_mount_path": str(tmp_path)})
            proc = await _data(client, "POST", "/api/v1/graph/agentic_process",
                               json={"name": "live data integrations", "project_id": project["id"], "workdir": str(tmp_path),
                                     "worker_type": "claude_code", "visible": False, "pty_mode": False, "process_type": "chat"})
            pid = proc["id"]
            subagents = await _data(client, "GET", "/api/v1/graph/subagent?include_system=true")
            for name in ("vibe", "data-integrations"):
                ref = next((s["asset_ref"] for s in subagents if s.get("name") == name and s.get("scope") == "system"), None)
                assert ref, f"system persona {name} is not indexed"
                await _data(client, "POST", f"/api/v1/graph/agentic_process/{pid}/load-embedded-subagent", json={"asset_ref": ref})

            prompt = (
                f"Connect this RSS feed: {feed}/feed.xml — name it 'live feed'. "
                "Then show me a sample and help me define the output; I want, per item, {\"sentiment\": \"string\"}. "
                "Create the dataset in this project, promote the sampled items, and label the first one as positive."
            )
            await client.post(f"/api/v1/graph/agentic_process/{pid}/prompt", json={"message": prompt},
                              timeout=httpx.Timeout(10.0, read=540.0))

            async def source():
                rows = await _data(client, "GET", "/api/v1/graph/data_source")
                return next((r for r in rows if feed in json.dumps(r.get("config") or {})), None)

            src = await _until(source, budget_s=240)
            assert src, "the agent never created the source"

            async def items():
                rows = await _data(client, "GET", f"/api/v1/graph/source_item?filter={json.dumps({'data_source_id': src['id']})}&limit=5")
                return rows or None

            assert await _until(items, budget_s=120), "no items streamed within the budget"

            async def labelled():
                rows = await _data(client, "GET", f"/api/v1/graph/dataset?filter={json.dumps({'source_id': src['id']})}")
                ds = next((d for d in rows if (d.get("num_annotated") or 0) >= 1), None)
                return ds

            ds = await _until(labelled, budget_s=200)
            assert ds, "no dataset with a gold label bound to the source"
            assert ds["spec"]["examples"][0]["input"] == "ingest.source_item"
            assert ds["spec"]["examples"][0]["output"] == {"sentiment": "string"}
            assert (tmp_path / "agentic-assets" / "dataset").is_dir()
