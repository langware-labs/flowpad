"""A local agent deployment IS a process: a real backend starts it, it answers its chat, it stops.

A real backend (``live_backend``, on this session's DB) with deployments turned on; two local
deployments of one agent, each running the stock loop on the mock worker
(``tests/utils/mock_agent_loop.py``). Over real HTTP: each deployment's ``chat`` endpoint is
answered by THAT deployment's own process; pausing one ends its process, while the other keeps
answering.
"""
from __future__ import annotations

import httpx
import pytest

from flow_sdk.builtin import deployment_process
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.deployment import Deployment
from flow_sdk.builtin.service_endpoint import ServiceEndpoint
from tests.long_tests._deployments import WRAPPER, agent, alive, end, ready, run

pytestmark = [pytest.mark.timeout(90)]  # do not increase timeout without approval


def _chat(backend: str, endpoint, text: str) -> httpx.Response:
    url = f"{backend}/api/v1/graph/service_endpoint/{endpoint.id}/service/v1/chat/completions"
    return httpx.post(url, json={"model": "agent", "messages": [{"role": "user", "content": text}]}, timeout=70)


def _answered(backend: str, chat, text: str) -> None:
    resp = _chat(backend, chat, text)
    assert resp.status_code == 200, resp.text
    assert resp.json()["choices"][0]["message"]["content"].startswith("Mock reply")


@pytest.mark.long  # ~8s: a real backend boot, two processes, three turns on the mock worker
def test_two_local_deployments_are_two_processes_each_answering_its_chat(deployments_backend):
    owner = agent("proc-agent")
    first = run(owner.run_locally(snippet=WRAPPER))
    second = run(owner.run_locally(snippet=WRAPPER))
    try:
        assert (first.slot, second.slot) == ("", "2") and first.id != second.id
        logs = {d.id: ready(d, 1) for d in (first, second)}
        pids = {deployment_process.pid_of(alive(d)) for d in (first, second)}
        assert len(pids) == 2, "two deployments, two processes"
        for deployment in (first, second):
            assert f"deployment {deployment.id}:" in logs[deployment.id].read_text(), "the process runs THIS deployment"
            assert f"deployment {deployment.id}: pid {deployment_process.pid_of(deployment)}" in logs[deployment.id].read_text(), \
                "its terminal is where it runs"

        chats = {d.id: run(ServiceEndpoint.find_existing(str(d.typeid), "chat")) for d in (first, second)}
        for deployment in (first, second):
            _answered(deployments_backend, chats[deployment.id], f"hello {deployment.slot or 'default'}")
            (process,) = run(AgenticProcess.local_rows({"match": {"deployment_id": deployment.id}}))
            assert process.status != "failed", "answered by a process of THIS deployment"

        # Pausing one ends its process at once; the other keeps answering.
        assert run(first.pause()) is True
        assert not deployment_process.alive(run(Deployment.get_by_id(first.id)))
        assert alive(second)
        _answered(deployments_backend, chats[second.id], "still there?")
    finally:
        end(first, second)  # processes outlive the app by design: a test that fails half-way must end them
