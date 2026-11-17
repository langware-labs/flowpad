"""A QA row's identity is its natural key, looked up — its id is an ordinary uuid4, never derived from the key.

Q sends no id: a create for a key a row already holds (a retried write) answers with that row, through the
ordinary graph create route (``find_existing_for_create``).
"""

from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.qa import QATestExecution

pytestmark = pytest.mark.asyncio

GRAPH = "/api/v1/graph"


async def _create(client, type_name: str, body: dict) -> str:
    resp = await client.post(f"{GRAPH}/{type_name}", json={"type": type_name, **body})
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]["id"]


async def test_a_retried_create_lands_on_the_same_row_under_a_minted_uuid4(bootstrapped_client):
    cycle = {"repo": "org/identity", "label": "qa-20261116-090000", "branch": "main", "name": "nightly"}
    cycle_ids = {await _create(bootstrapped_client, "qa_cycle", cycle) for _ in range(2)}
    assert len(cycle_ids) == 1, cycle_ids
    (cycle_id,) = cycle_ids
    assert uuid.UUID(cycle_id).version == 4, "minted, not derived from the natural key"

    in_cycle = f"qa_cycle-{cycle_id}"
    iteration_id = await _create(bootstrapped_client, "qa_iteration", {"parent_type_id": in_cycle, "order": 1, "label": "i01"})
    assert await _create(bootstrapped_client, "qa_iteration", {"parent_type_id": in_cycle, "order": 1, "label": "i01"}) == iteration_id
    assert await _create(bootstrapped_client, "qa_iteration", {"parent_type_id": in_cycle, "order": 2, "label": "i02"}) != iteration_id

    attempt = {"cycle_id": cycle_id, "parent_type_id": f"qa_iteration-{iteration_id}", "test_file_id": "f1", "test_name": "test_login", "status": "fail"}
    first = await _create(bootstrapped_client, "qa_test_execution", {**attempt, "attempt": 1})
    assert await _create(bootstrapped_client, "qa_test_execution", {**attempt, "attempt": 1}) == first
    second = await _create(bootstrapped_client, "qa_test_execution", {**attempt, "attempt": 2, "status": "pass"})
    assert second != first
    assert len(await QATestExecution.get_all({"parent_type_id": f"qa_iteration-{iteration_id}"})) == 2


async def test_a_test_file_is_one_row_per_repository_whatever_its_phase(bootstrapped_client):
    phase_1 = await _create(bootstrapped_client, "qa_phase", {"repo": "org/identity-files", "step": 1, "name": "unit"})
    phase_2 = await _create(bootstrapped_client, "qa_phase", {"repo": "org/identity-files", "step": 2, "name": "e2e"})
    file_id = await _create(bootstrapped_client, "qa_test_file", {"repo": "org/identity-files", "phase_id": phase_1, "path": "tests/test_a.py"})
    assert await _create(bootstrapped_client, "qa_test_file", {"repo": "org/identity-files", "phase_id": phase_2, "path": "tests/test_a.py"}) == file_id
    assert await _create(bootstrapped_client, "qa_test_file", {"repo": "org/other", "phase_id": phase_1, "path": "tests/test_a.py"}) != file_id
