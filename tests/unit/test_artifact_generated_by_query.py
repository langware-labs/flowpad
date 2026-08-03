"""`generated_by` — a process's artifacts are a QUERY, never a field on the process.

The provenance edge points artifact → producing process, stored as a plain
indexed field holding a TypeId string. That direction matters:

* the process never grows an ``artifacts`` list, so two workers registering
  concurrently cannot clobber each other's append (the failure mode a
  ``private_context_entities`` cross-link would have);
* provenance is historical — deleting the process does not retract what it made.

Mechanism follows ``Deployment.artifact_id``: a field plus a match filter, which
is what "searchable by design" means in this codebase — there is no edge-type
registry for entities.
"""

from __future__ import annotations

import asyncio

import pytest

from flow_sdk.builtin.artifact import Artifact

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval

_PROC_A = "agentic_process-3f2a1b4c-0000-4000-8000-00000000000a"
_PROC_B = "agentic_process-3f2a1b4c-0000-4000-8000-00000000000b"


async def _mint(name: str, generated_by: str | None) -> Artifact:
    artifact = Artifact(
        name=name,
        kind="content.file.text",
        generated_by=generated_by,
    )
    await artifact.save(notify=False)
    return artifact


# ── the edge ──────────────────────────────────────────────────────────────────


async def test_generated_by_round_trips_as_a_typeid_string():
    """A TypeId, not a bare uuid — a graph run or subagent must be able to
    produce artifacts too, and a bare uuid could not discriminate the producer."""
    artifact = await _mint("report", _PROC_A)

    fetched = await Artifact.get_by_id(artifact.id)
    assert fetched is not None
    assert fetched.generated_by == _PROC_A


async def test_generated_by_defaults_to_none():
    """Provenance is never invented — an artifact with no known producer says so."""
    artifact = await _mint("orphan", None)

    fetched = await Artifact.get_by_id(artifact.id)
    assert fetched is not None
    assert fetched.generated_by is None


# ── the query ─────────────────────────────────────────────────────────────────


async def test_artifacts_of_a_process_is_a_query():
    mine = {(await _mint(f"a{i}", _PROC_A)).id for i in range(3)}
    theirs = {(await _mint(f"b{i}", _PROC_B)).id for i in range(2)}

    found = {a.id for a in await Artifact.get_all({"generated_by": _PROC_A})}

    assert mine <= found
    assert not (theirs & found)


async def test_the_process_never_grows_an_artifacts_field():
    """The edge lives on the artifact. A list on the process would be a second
    source of truth, and a last-writer-wins one at that."""
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

    assert "artifacts" not in AgenticProcess.model_fields


async def test_concurrent_registrations_both_survive():
    """The test a cross-link edge would fail: two artifacts registered at the
    same instant against the same producer, neither losing the other."""
    a, b = await asyncio.gather(
        _mint("concurrent-a", _PROC_A),
        _mint("concurrent-b", _PROC_A),
    )

    found = {x.id for x in await Artifact.get_all({"generated_by": _PROC_A})}
    assert {a.id, b.id} <= found


async def test_retired_generating_flow_id_does_not_alias_into_generated_by():
    """``generating_flow_id`` was retired by the Artifact/Deployment migration.
    The new field must be a new concept, not a silent rename of the old one —
    otherwise stale rows resurrect provenance that was deliberately dropped."""
    artifact = Artifact(name="legacy", kind="content.file", generating_flow_id="flow-123")

    assert artifact.generated_by is None
