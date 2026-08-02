"""`register-artifact` — the one action every producer calls.

An artifact is a REFERENCE to a generated asset plus the provenance edge back to
the run that made it. Registration is explicit (the base agent's instructions
carry a ``flow artifact`` call); nothing is inferred from file writes and nothing
is swept off disk.

Mirrors the envelope of the webapp registration it generalizes, so the port form
keeps working while entity- and path-addressed deliverables gain the same
lifecycle they never had.
"""

from __future__ import annotations

from flow_sdk.builtin.artifact import Artifact
from flow_sdk.builtin.spec import Spec

from .conftest import create_agentic_process


async def _register(client, pid: str, **body):
    return await client.post(f"/api/v1/graph/agentic_process/{pid}/register-artifact", json=body)


async def _a_spec(name: str = "the-deliverable") -> Spec:
    # Canonical path: the indexer always writes a resolved asset_ref, and
    # `resolve_display_target` canonicalizes what it is handed. A fixture using
    # the raw form would diverge on macOS (/tmp -> /private/tmp) and test a
    # mismatch that never occurs in practice.
    from pathlib import Path

    ref = str(Path(f"/tmp/artifact-register/{name}.md").expanduser().resolve())
    spec = Spec(name=name, asset_ref=ref)
    await spec.save(notify=False)
    return spec


# ── the reference ─────────────────────────────────────────────────────────────


async def test_register_by_typeid_references_the_entity(bootstrapped_client):
    pid = await create_agentic_process(bootstrapped_client)
    spec = await _a_spec()

    res = await _register(bootstrapped_client, pid, typeid=f"spec-{spec.id}")

    assert res.status_code == 200, res.text
    artifact = res.json()["data"]["artifact"]
    assert artifact["asset_ref"] == spec.asset_ref


async def test_register_by_path_references_the_indexed_entity(bootstrapped_client):
    """A path that already resolves to an entity records that entity's ref —
    the artifact points at the asset, never at a bare path it duplicates."""
    pid = await create_agentic_process(bootstrapped_client)
    spec = await _a_spec("by-path")

    res = await _register(bootstrapped_client, pid, path=spec.asset_ref)

    assert res.status_code == 200, res.text
    assert res.json()["data"]["artifact"]["asset_ref"] == spec.asset_ref


# ── the provenance edge ───────────────────────────────────────────────────────


async def test_register_stamps_generated_by_from_the_calling_process(bootstrapped_client):
    """The agent never passes provenance — the action derives it from the URL
    scope, so an artifact cannot claim a producer it did not have."""
    pid = await create_agentic_process(bootstrapped_client)
    spec = await _a_spec("provenance")

    res = await _register(bootstrapped_client, pid, typeid=f"spec-{spec.id}")

    assert res.json()["data"]["artifact"]["generated_by"] == f"agentic_process-{pid}"


async def test_generated_by_is_not_taken_from_the_body(bootstrapped_client):
    """A caller-supplied producer must not be honoured — provenance is a fact
    about who ran, not a claim the payload gets to make."""
    pid = await create_agentic_process(bootstrapped_client)
    spec = await _a_spec("spoof")

    res = await _register(
        bootstrapped_client,
        pid,
        typeid=f"spec-{spec.id}",
        generated_by="agentic_process-00000000-0000-4000-8000-00000000dead",
    )

    assert res.json()["data"]["artifact"]["generated_by"] == f"agentic_process-{pid}"


# ── the query ─────────────────────────────────────────────────────────────────


async def test_artifacts_action_returns_this_processes_artifacts(bootstrapped_client):
    pid = await create_agentic_process(bootstrapped_client)
    for i in range(2):
        await _register(bootstrapped_client, pid, typeid=f"spec-{(await _a_spec(f'q{i}')).id}")

    res = await bootstrapped_client.get(f"/api/v1/graph/agentic_process/{pid}/artifacts")

    assert res.status_code == 200, res.text
    rows = res.json()["data"]["artifacts"]
    assert len(rows) == 2
    assert {r["generated_by"] for r in rows} == {f"agentic_process-{pid}"}


async def test_two_processes_do_not_see_each_others_artifacts(bootstrapped_client):
    pid_a = await create_agentic_process(bootstrapped_client)
    pid_b = await create_agentic_process(bootstrapped_client)
    await _register(bootstrapped_client, pid_a, typeid=f"spec-{(await _a_spec('mine')).id}")
    await _register(bootstrapped_client, pid_b, typeid=f"spec-{(await _a_spec('yours')).id}")

    rows_a = (await bootstrapped_client.get(f"/api/v1/graph/agentic_process/{pid_a}/artifacts")).json()["data"][
        "artifacts"
    ]

    assert len(rows_a) == 1
    assert rows_a[0]["generated_by"] == f"agentic_process-{pid_a}"


# ── the display side effect ───────────────────────────────────────────────────


async def test_registering_shows_by_default(bootstrapped_client):
    pid = await create_agentic_process(bootstrapped_client)
    spec = await _a_spec("shown")

    res = await _register(bootstrapped_client, pid, typeid=f"spec-{spec.id}")

    assert res.json()["data"]["shown"] is not None
    row = (await bootstrapped_client.get(f"/api/v1/graph/agentic_process/{pid}")).json()["data"]
    assert row["context_data"]["last_shown"] == res.json()["data"]["shown"]


async def test_no_show_suppresses_the_display(bootstrapped_client):
    pid = await create_agentic_process(bootstrapped_client)
    spec = await _a_spec("quiet")

    res = await _register(bootstrapped_client, pid, typeid=f"spec-{spec.id}", show=False)

    assert res.json()["data"]["shown"] is None
    row = (await bootstrapped_client.get(f"/api/v1/graph/agentic_process/{pid}")).json()["data"]
    assert not (row.get("context_data") or {}).get("last_shown")


async def test_the_latest_registration_wins_the_screen(bootstrapped_client):
    pid = await create_agentic_process(bootstrapped_client)
    first, second = await _a_spec("first"), await _a_spec("second")

    await _register(bootstrapped_client, pid, typeid=f"spec-{first.id}")
    res = await _register(bootstrapped_client, pid, typeid=f"spec-{second.id}")

    row = (await bootstrapped_client.get(f"/api/v1/graph/agentic_process/{pid}")).json()["data"]
    assert row["context_data"]["last_shown"] == res.json()["data"]["shown"]
    assert len(row["context_data"]["display_stack"]) == 2


# ── errors ────────────────────────────────────────────────────────────────────


async def test_unknown_entity_is_a_404(bootstrapped_client):
    pid = await create_agentic_process(bootstrapped_client)

    res = await _register(
        bootstrapped_client,
        pid,
        typeid="spec-00000000-0000-4000-8000-0000000000ff",
    )

    assert res.status_code == 404


async def test_no_address_is_a_400(bootstrapped_client):
    pid = await create_agentic_process(bootstrapped_client)

    res = await _register(bootstrapped_client, pid, name="nothing to point at")

    assert res.status_code == 400


# ── the artifact never shadows what it references ─────────────────────────────


async def test_registering_does_not_steal_path_ownership(bootstrapped_client):
    """After registration the path must still resolve to the asset, not to the
    artifact that references it."""
    from flow_sdk.core import Entity

    pid = await create_agentic_process(bootstrapped_client)
    spec = await _a_spec("ownership")
    await _register(bootstrapped_client, pid, typeid=f"spec-{spec.id}")

    resolved = await Entity.get_by_asset_ref(spec.asset_ref)

    assert resolved is not None and resolved.get_type() == "spec"
    assert await Artifact.get_one({"generated_by": f"agentic_process-{pid}"}) is not None
