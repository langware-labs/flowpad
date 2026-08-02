"""Artifacts reach the screen live — the realtime half of the matrix.

The client watches a query scoped to ``generated_by``; a newly registered
artifact must therefore arrive as a ``create`` data-op carrying that field, so a
watching UI updates without refetching. The display pin (``on_show``) is a
SEPARATE channel: it says which artifact is currently presented, not which ones
exist.

Captures ``handle_entity_op`` — the last hop before the socket — rather than
stubbing the emitter, so a pass means the real broadcast path ran.
"""

from __future__ import annotations

import pytest

from .conftest import create_agentic_process


@pytest.fixture
def captured_ops(monkeypatch):
    ops: list[tuple[str, str, dict]] = []

    async def _capture(op_message):
        # ``data`` is the entity itself on this hop (it is serialized further
        # down, per connection). Normalize so assertions read one shape.
        payload = getattr(op_message, "data", None)
        if payload is not None and not isinstance(payload, dict):
            payload = payload.model_dump(mode="json")
        ops.append(
            (
                str(getattr(op_message, "op", "")),
                str(getattr(op_message, "to_entity", "")),
                payload or {},
            )
        )

    monkeypatch.setattr("flow_sdk.core.network.resource_tracker.handle_entity_op", _capture)
    return ops


async def _a_spec(name: str):
    from pathlib import Path

    from flow_sdk.builtin.spec import Spec

    spec = Spec(name=name, asset_ref=str(Path(f"/tmp/artifact-ws/{name}.md").expanduser().resolve()))
    await spec.save(notify=False)
    return spec


async def _register(client, pid: str, **body):
    return await client.post(f"/api/v1/graph/agentic_process/{pid}/register-artifact", json=body)


def _artifact_creates(ops):
    return [(to, data) for op, to, data in ops if op == "create" and to.startswith("artifact-")]


async def test_registration_broadcasts_a_create_op(bootstrapped_client, captured_ops):
    pid = await create_agentic_process(bootstrapped_client)
    spec = await _a_spec("live")

    res = await _register(bootstrapped_client, pid, typeid=f"spec-{spec.id}")
    assert res.status_code == 200, res.text

    creates = _artifact_creates(captured_ops)
    assert creates, f"no artifact create op broadcast; saw {[(o, t) for o, t, _ in captured_ops]}"
    assert creates[-1][0] == f"artifact-{res.json()['data']['artifact']['id']}"


async def test_the_broadcast_carries_generated_by(bootstrapped_client, captured_ops):
    """Without it the client cannot tell whether the new artifact belongs to the
    query it is watching, and would have to refetch to find out."""
    pid = await create_agentic_process(bootstrapped_client)
    spec = await _a_spec("attributed")

    await _register(bootstrapped_client, pid, typeid=f"spec-{spec.id}")

    _, data = _artifact_creates(captured_ops)[-1]
    assert data.get("generated_by") == f"agentic_process-{pid}"


async def test_each_registration_broadcasts_once(bootstrapped_client, captured_ops):
    """Two artifacts, two creates — no duplicate frame from the show side effect
    also touching the artifact."""
    pid = await create_agentic_process(bootstrapped_client)

    await _register(bootstrapped_client, pid, typeid=f"spec-{(await _a_spec('one')).id}")
    await _register(bootstrapped_client, pid, typeid=f"spec-{(await _a_spec('two')).id}")

    assert len(_artifact_creates(captured_ops)) == 2


async def test_registering_without_show_still_broadcasts(bootstrapped_client, captured_ops):
    """Existence and presentation are separate channels: an artifact registered
    with --no-show must still reach a watching client's list."""
    pid = await create_agentic_process(bootstrapped_client)
    spec = await _a_spec("quiet-but-live")

    res = await _register(bootstrapped_client, pid, typeid=f"spec-{spec.id}", show=False)

    assert res.json()["data"]["shown"] is None
    assert _artifact_creates(captured_ops), "an unshown artifact never reached the wire"
