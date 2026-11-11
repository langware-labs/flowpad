"""`POST /project/<id>/deploy` takes a typed body (``DeployRequest``), validated by the dispatcher before the
action runs — so a bad one is a 400 and nothing is published, planned or placed."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from flow_sdk.builtin.deployment import Deployment
from tests.unit.agent._seed import seed_project

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


@pytest.mark.parametrize(
    "body, says",
    [
        ({"provider": "gcp_vm", "environment": "Not Valid"}, "not a valid environment name"),
        ({"provider": "gcp_vm", "token_allocation": {"source": "llm_endpoint-x", "model": "claude-*"}}, "one model"),
        ({"provider": "gcp_vm", "source_kind": "branch"}, "source_kind"),
    ],
)
async def test_a_bad_deploy_body_is_refused_before_the_action_runs(bootstrapped_client, body, says):
    project = await seed_project(Path(tempfile.mkdtemp()) / "proj")

    answer = await bootstrapped_client.post(f"/api/v1/graph/project/{project.id}/deploy", json=body)

    assert answer.status_code == 400 and says in answer.text, answer.text
    assert await Deployment.get_all({"match": {"parent_type_id": str(project.typeid)}}) == []
