"""A cloud deploy answers before its machine exists and reports its steps as an activity (FLOWPAD-2311).

`POST /agent/<id>/deploy` used to hold the request for the whole deploy — publish, plan, readiness
and the hub booting a machine — so the dialog showed a spinner for minutes with nothing behind
it. The contract pinned here: the desktop ACCEPTS (200, naming its activity) before the machine is
placed, and every step arrives over the WebSocket as a block of that activity,
addressed to the agent, until the run ends. Model funding is a warning, not a gate: a deploy whose
token allocation has nothing to spend is still accepted, and the answer says so.

Nothing is mocked. A live, launcher-owned instance signed in to a hub that offers ``gcp_vm``
deploys a throwaway agent onto a REAL GCP VM, and the test listens on the same ``progress_report``
frames the app renders. The machine is billed while it lives; the test deletes the deployment
(and so the machine) whatever happens::

    scripts/instance_ctl.sh launch <name> --hub <hub url>      # then sign it in
    FLOWPAD_DEPLOY_E2E_INSTANCE=<name> \
    FLOWPAD_DEPLOY_E2E_TOKEN_SOURCE=<llm_endpoint id you administer> \
        pytest tests/long_tests/test_cloud_deploy_activity_live.py

Opt-in and never in CI: unset, it skips. The token source is named, never picked: the unfunded
case allocates from it, and whose budget that is is the runner's call.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from typing import TYPE_CHECKING, Any, TypeAlias

import httpx
import pytest
import websockets

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator
    from pathlib import Path

    from websockets.asyncio.client import ClientConnection

    from tests.long_tests.conftest import LiveE2EInstance

#: A decoded JSON object: an API envelope, a WebSocket frame, an activity snapshot.
JsonObject: TypeAlias = dict[str, Any]

ENV_KEY: str = "FLOWPAD_DEPLOY_E2E_INSTANCE"
#: The hub LLM endpoint the unfunded allocation is drawn from — one the runner administers.
TOKEN_SOURCE_ENV_KEY: str = "FLOWPAD_DEPLOY_E2E_TOKEN_SOURCE"
#: The hub's name for the provider (``deployment/providers``); the desktop has no enum member for it.
PROVIDER: str = "gcp_vm"
#: The deploy's activity, and its blocks in the order they run.
DEPLOY_ACTIVITY: str = "deploy"
STEPS: tuple[str, ...] = ("publish", "dependencies", "plan", "readiness", "machine")
#: How the accepted answer says the placement has no model funding.
NO_FUNDING_WARNING: str = "No LLM funding for"
#: Creating and enrolling a GCP VM, then cloning and signing in, is the hub's own live-test budget
#: (1200s); a deploy still running after this is broken, and the last frame says where it stopped.
DEPLOY_LIMIT_S: int = 1200
TERMINAL: set[str] = {"completed", "failed", "cancelled", "interrupted"}


@pytest.fixture()
def instance(resolve_live_e2e_instance: Callable[[str], LiveE2EInstance]) -> LiveE2EInstance:
    """The selected instance — signed in, on a hub that offers ``gcp_vm``, or nothing runs."""
    live: LiveE2EInstance = resolve_live_e2e_instance(ENV_KEY)
    base: str = f"http://127.0.0.1:{live.backend_port}"
    status: JsonObject = httpx.get(f"{base}/api/v1/cloud/status", timeout=30).json()["data"]
    if status["login"]["status"] != "logged_in":
        pytest.fail(f"{live.name} is not signed in to {live.hub_url}", pytrace=False)
    offered: list[str] = httpx.get(f"{base}/api/v1/graph/deployment/providers", timeout=30).json().get("data") or []
    if PROVIDER not in offered:
        pytest.fail(f"{live.hub_url} does not offer {PROVIDER} (offers {offered})", pytrace=False)
    return live


@pytest.fixture()
def mock_agent(instance: LiveE2EInstance, tmp_path: Path) -> Iterator[tuple[str, str]]:
    """A throwaway agent in a throwaway project — what a person deploys. Yields ``(base url, agent id)``.

    On the way out every deployment of it is deleted first: deleting the placement is what destroys
    its machine on the hub, and a failure there is reported, because it is a billed VM left running.
    """
    base: str = f"http://127.0.0.1:{instance.backend_port}"
    suffix: str = uuid.uuid4().hex[:8]
    client: httpx.Client
    with httpx.Client(base_url=base, timeout=60) as client:
        project: JsonObject = client.post(
            "/api/v1/graph/project",
            json={
                "type": "project",
                "name": f"deploy-e2e-{suffix}",
                "fs_storage_mount_path": str(tmp_path / "project"),
            },
        ).json()["data"]
        agent: JsonObject = client.post(
            f"/api/v1/graph/project/{project['id']}/agent",
            json={"type": "agent", "name": f"deploy-e2e-{suffix}", "system_prompt": "Answer in one word."},
        ).json()["data"]
        try:
            yield base, agent["id"]
        finally:
            leaked: list[tuple[str, str]] = []
            row: JsonObject
            for row in _deployments_of(client, agent["id"]):
                gone: httpx.Response = client.delete(f"/api/v1/graph/deployment/{row['id']}", timeout=DEPLOY_LIMIT_S)
                if gone.json().get("status") != "SUCCESS":
                    leaked.append((row["id"], gone.text))
            client.delete(f"/api/v1/graph/agent/{agent['id']}")
            client.delete(f"/api/v1/graph/project/{project['id']}")
            assert not leaked, f"deployment machines may still be running on the hub: {leaked}"


@pytest.fixture()
def unfunded_allocation(instance: LiveE2EInstance) -> JsonObject:
    """A token allocation with nothing to spend: $0 a day from the named source, pinned to a model it serves.

    A zero limit is what the hub's gate reads as "no budget is allocated" — the same refusal an
    exhausted one gives — so the placement is unfunded by construction, not by whatever the
    account happens to have left. The model is one the source really offers, so the zero limit is
    the only reason a turn would be refused.
    """
    source_id: str = os.environ.get(TOKEN_SOURCE_ENV_KEY, "").strip().removeprefix("llm_endpoint-")
    if not source_id:
        pytest.skip(f"{TOKEN_SOURCE_ENV_KEY} is not set; name an llm_endpoint you administer to allocate from")
    base: str = f"http://127.0.0.1:{instance.backend_port}"
    # The endpoint lives on the hub, not in this instance: the desktop reflects the read there.
    listed: JsonObject = httpx.get(
        f"{base}/api/v1/graph/llm_endpoint/{source_id}/models", headers={"Hub-Reflect": "true"}, timeout=60
    ).json()
    models: list[JsonObject] = listed.get("data") or []
    if not models:
        pytest.fail(f"llm_endpoint {source_id} offers no models: {listed.get('message')}", pytrace=False)
    return {"source": f"llm_endpoint-{source_id}", "cost_usd_per_day": 0, "model": models[0]["id"]}


def _deployments_of(client: httpx.Client, agent_id: str) -> list[JsonObject]:
    rows: list[JsonObject] = client.get("/api/v1/graph/deployment").json().get("data") or []
    return [row for row in rows if row.get("parent_type_id") == f"agent-{agent_id}"]


async def _deploy_activity(ws: ClientConnection, subject: str) -> list[JsonObject]:
    """Every snapshot of the deploy's activity on *subject*, in order, until it ends."""
    snapshots: list[JsonObject] = []
    deadline: float = time.monotonic() + DEPLOY_LIMIT_S
    while time.monotonic() < deadline:
        try:
            msg: JsonObject = json.loads(await asyncio.wait_for(ws.recv(), timeout=deadline - time.monotonic()))
        except TimeoutError:
            break
        flow_data: JsonObject = msg.get("flow_data") or {}
        attrs: JsonObject = flow_data.get("attributes") or {}
        if (
            msg.get("message_type") != "flow_data_msg"
            or msg.get("to_entity") != subject
            or flow_data.get("element_type") != "progress_report"
            or attrs.get("kind") != "activity"
            or attrs.get("path") != DEPLOY_ACTIVITY
        ):
            continue
        # Out-of-order frames are the consumer's to drop: seq is monotonic per root.
        if snapshots and attrs["seq"] <= snapshots[-1]["seq"]:
            continue
        snapshots.append(attrs)
        if attrs["state"] in TERMINAL:
            return snapshots
    last: JsonObject | None = snapshots[-1] if snapshots else None
    pytest.fail(f"the deploy did not end within {DEPLOY_LIMIT_S}s; last snapshot: {last}")


async def _deploy_watched(
    instance: LiveE2EInstance, base: str, agent_id: str, body: JsonObject
) -> tuple[httpx.Response, list[JsonObject]]:
    """Deploy *agent_id* with *body* while watching it: the answer, and — when it was accepted — every
    snapshot of the deploy's activity until the run ends, so the cleanup finds whatever it placed."""
    subject: str = f"agent-{agent_id}"
    connection_id: str = f"deploy-e2e-{uuid.uuid4()}"
    client: httpx.AsyncClient
    ws: ClientConnection
    async with (
        httpx.AsyncClient(base_url=base, timeout=60) as client,
        websockets.connect(f"ws://127.0.0.1:{instance.backend_port}/api/v1/connect/ws/{connection_id}") as ws,
    ):
        hello: JsonObject = json.loads(await ws.recv())
        assert hello.get("message_type") == "response_msg"
        watched: httpx.Response = await client.post(
            f"/api/v1/graph/agent/{agent_id}/watch", json={"connection_id": connection_id}
        )
        assert watched.status_code == 200, watched.text

        # The whole deploy's budget, not a short one: a deploy that still blocks must END before the
        # caller's assert fails, so the cleanup finds its machine instead of racing one still being created.
        accepted: httpx.Response = await client.post(
            f"/api/v1/graph/agent/{agent_id}/deploy", json=body, timeout=DEPLOY_LIMIT_S
        )
        # Taken on = an answer naming the activity it reports on; anything else is the outcome itself.
        if accepted.status_code != 200 or not (accepted.json().get("data") or {}).get("activity"):
            return accepted, []
        return accepted, await _deploy_activity(ws, subject)


# A real GCP VM is created, then deleted. Do not increase without approval.
@pytest.mark.timeout(DEPLOY_LIMIT_S * 2 + 60)
async def test_deploy_is_accepted_and_streams_its_steps(instance: LiveE2EInstance, mock_agent: tuple[str, str]) -> None:
    base: str
    agent_id: str
    base, agent_id = mock_agent

    accepted: httpx.Response
    snapshots: list[JsonObject]
    accepted, snapshots = await _deploy_watched(instance, base, agent_id, {"provider": PROVIDER})

    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["data"]["activity"] == {"path": DEPLOY_ACTIVITY, "subject_entity": f"agent-{agent_id}"}
    final: JsonObject = snapshots[-1]
    assert final["state"] == "completed", f"{final['state']}: {final.get('message')}"
    blocks: list[tuple[str, str]] = [(block["name"], block["state"]) for block in final["children"]]
    assert blocks == [(step, "completed") for step in STEPS]
    # Streamed, not reported once at the end: the machine step was seen while it ran.
    running: set[str] = {
        block["name"] for snap in snapshots for block in snap["children"] if block["state"] == "running"
    }
    assert "machine" in running, f"no snapshot showed the machine step running: {[s['seq'] for s in snapshots]}"

    reader: httpx.Client
    with httpx.Client(base_url=base, timeout=60) as reader:
        placed: list[tuple[str, str]] = [
            (row["target"]["provider"], row["status"]["provider_state"]) for row in _deployments_of(reader, agent_id)
        ]
    assert placed == [(PROVIDER, "running")]


# A real GCP VM is created, then deleted. Do not increase without approval.
@pytest.mark.timeout(DEPLOY_LIMIT_S * 2 + 60)
async def test_an_unfunded_deploy_is_still_accepted_with_a_warning(
    instance: LiveE2EInstance, mock_agent: tuple[str, str], unfunded_allocation: JsonObject
) -> None:
    base: str
    agent_id: str
    base, agent_id = mock_agent
    body: JsonObject = {"provider": PROVIDER, "token_allocation": unfunded_allocation}

    accepted: httpx.Response
    snapshots: list[JsonObject]
    accepted, snapshots = await _deploy_watched(instance, base, agent_id, body)

    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["data"]["activity"] == {"path": DEPLOY_ACTIVITY, "subject_entity": f"agent-{agent_id}"}
    warnings: list[str] = accepted.json()["data"].get("warnings") or []
    assert any(w.lower().startswith(NO_FUNDING_WARNING.lower()) for w in warnings), warnings
    # A warning, not a gate: the deploy runs to the end without funding.
    final: JsonObject = snapshots[-1]
    assert final["state"] == "completed", f"{final['state']}: {final.get('message')}"
