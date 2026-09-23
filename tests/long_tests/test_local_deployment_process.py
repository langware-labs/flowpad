"""A local agent deployment IS a process: a real backend starts it, it answers its chat, it stops.

A real backend (``live_backend``, on this session's DB) with deployments turned on; two local
deployments of one agent, each running the stock loop on the mock worker
(``tests/utils/mock_agent_loop.py``). Over real HTTP: each deployment's ``chat`` endpoint is
answered by THAT deployment's own process; pausing one ends its process, while the other keeps
answering.
"""
from __future__ import annotations

import asyncio
import time
import uuid
from pathlib import Path

import httpx
import pytest

from flow_sdk.builtin import deployment_process
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.deployment import Deployment
from flow_sdk.builtin.service_endpoint import ServiceEndpoint

pytestmark = [pytest.mark.timeout(90)]  # do not increase timeout without approval

WRAPPER = str(Path(__file__).resolve().parents[1] / "utils" / "mock_agent_loop.py")


@pytest.fixture
def runs_deployments(monkeypatch, tmp_path):
    """Before the backend boots: it starts deployment processes, looks again every second, and their
    loops run on the mock worker."""
    monkeypatch.setenv("AGENT_RUN_DEPLOYMENTS", "true")
    monkeypatch.setenv("AGENT_WATCH_SECONDS", "1")
    monkeypatch.setenv("MOCK_TRANSCRIPTS", str(tmp_path / "mock-transcripts"))


@pytest.fixture
def backend(runs_deployments, live_backend):
    return f"http://127.0.0.1:{live_backend}"


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _until(what, predicate, *, within: float):
    deadline = time.monotonic() + within
    while time.monotonic() < deadline:
        found = predicate()
        if found:
            return found
        time.sleep(0.25)
    pytest.fail(f"{what}: not within {within}s")


def _chat(backend: str, endpoint, text: str) -> httpx.Response:
    url = f"{backend}/api/v1/graph/service_endpoint/{endpoint.id}/service/v1/chat/completions"
    return httpx.post(url, json={"model": "agent", "messages": [{"role": "user", "content": text}]}, timeout=70)


@pytest.mark.long  # ~8s: a real backend boot, two processes, three turns on the mock worker
def test_two_local_deployments_are_two_processes_each_answering_its_chat(backend, tmp_path):
    agent = Agent(name=f"proc-agent-{uuid.uuid4().hex[:6]}", worker_type="claude", system_prompt="Answer briefly.")
    _run(agent.save())
    first = _run(agent.run_locally(snippet=WRAPPER))
    second = _run(agent.run_locally(snippet=WRAPPER))
    try:
        _check(backend, first, second)
    finally:
        # Deployment processes outlive the app that started them — by design — so a test that fails
        # half-way must end them itself, or they keep running against this test's database.
        for deployment in (first, second):
            fresh = _run(Deployment.get_by_id(deployment.id))
            if fresh is not None:
                deployment_process.stop(fresh)


def _check(backend: str, first, second) -> None:
    assert (first.slot, second.slot) == ("", "2") and first.id != second.id

    def running(deployment):
        fresh = _run(Deployment.get_by_id(deployment.id))
        return fresh if deployment_process.alive(fresh) else None

    first = _until("the first deployment's process", lambda: running(first), within=30)
    second = _until("the second deployment's process", lambda: running(second), within=30)
    pids = {deployment_process.recorded(d).pid for d in (first, second)}
    assert len(pids) == 2, "two deployments, two processes"

    for deployment in (first, second):
        log = Path(deployment_process.recorded(deployment).log)
        _until(f"{deployment.id}'s loop to start ({log}: {log.read_text()[-1500:] if log.exists() else 'no log'})", lambda log=log: log.exists() and "answers 1 channel(s)" in log.read_text(), within=30)
        assert f"deployment {deployment.id}:" in log.read_text(), "the process runs THIS deployment"

    chats = {d.id: _run(ServiceEndpoint.find_existing(str(d.typeid), "chat")) for d in (first, second)}
    for deployment in (first, second):
        resp = _chat(backend, chats[deployment.id], f"hello {deployment.slot or 'default'}")
        assert resp.status_code == 200, resp.text
        assert resp.json()["choices"][0]["message"]["content"].startswith("Mock reply")
        (process,) = _run(AgenticProcess.local_rows({"match": {"deployment_id": deployment.id}}))
        assert process.status != "failed", "answered by a process of THIS deployment"

    # Pausing one ends its process; the other keeps answering.
    assert _run(first.pause()) is True
    _until("the stopped deployment's process to end",
           lambda: not deployment_process.alive(_run(Deployment.get_by_id(first.id))) or None, within=30)
    assert deployment_process.alive(_run(Deployment.get_by_id(second.id)))
    resp = _chat(backend, chats[second.id], "still there?")
    assert resp.status_code == 200 and resp.json()["choices"][0]["message"]["content"].startswith("Mock reply")

    assert _run(second.pause()) is True
    _until("the second process to end", lambda: not deployment_process.alive(_run(Deployment.get_by_id(second.id))) or None,
           within=30)
