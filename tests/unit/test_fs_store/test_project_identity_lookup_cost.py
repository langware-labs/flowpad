"""Resolving a project's identity must not re-read the whole project corpus.

`GET /fs-records/scan` resolves identity for every walked node. For a project
that lands in `existing_project_record_id` -> `_find_project_record_by_cwd`
(claude_projects.py:91), which does:

    records = sorted(FSRecord.discover(RecordType.PROJECT), ...)   # the WHOLE corpus
    for record in records: ...compare up to 4 canonicalized path fields...

per call. So resolving N project refs re-enumerates and re-scans all M project
records N times — O(N*M).

Measured on a real instance (158 project refs, 3129 project records on disk):

    as-is                       39.1s wall, 222.92ms per project ref
    memoize the discover        15.7s wall,  74.64ms per project ref
    build {cwd: record} once     5.5s wall,   4.86ms per project ref

The other walked types are not implicated: codex_session 0.35ms/ref,
claude_session 0.23ms/ref.

`FSRecord.discover` is wrapped with a COUNTING SPY that delegates to the real
implementation — the corpus, the records and the lookup are all real. The spy
observes how often the real function runs; it never stands in for it.
"""

from __future__ import annotations

import pathlib
import time

import pytest

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.record_types import RecordType

#: Enough project records that a per-lookup corpus sweep is unmistakable.
CORPUS = 120
#: Refs resolved in one pass — the scan resolves every walked project.
LOOKUPS = 40

#: The corpus below must be the only one on disk.
pytestmark = pytest.mark.usefixtures("tmp_records_root")


@pytest.fixture
def project_corpus(tmp_path):
    """`CORPUS` real project records on disk, each owning a distinct cwd."""
    cwds = []
    for i in range(CORPUS):
        cwd = tmp_path / "workspaces" / f"proj{i:04d}"
        cwd.mkdir(parents=True)
        record = FSRecord(
            type=RecordType.PROJECT,
            id=f"00000000-0000-4000-8000-{i:012d}",
            name=f"proj{i:04d}",
            cwd=str(cwd),
        )
        record.save()
        cwds.append(str(cwd))
    return cwds


# do not increase timeout without approval
@pytest.mark.timeout(30)
def test_project_identity_does_not_rescan_the_corpus_per_lookup(project_corpus, monkeypatch):
    """Resolving many projects must enumerate the corpus once, not once each.

    Fails today: every lookup calls `FSRecord.discover(PROJECT)` again, so the
    scan's cost is projects-squared.
    """
    from flow_sdk.fs_store.indexer.functions import claude_projects

    calls = {"n": 0}
    real_discover = FSRecord.discover

    def counting_discover(record_type):
        if str(record_type) == str(RecordType.PROJECT):
            calls["n"] += 1
        return real_discover(record_type)

    # A spy over the REAL implementation — the lookup still does its real work.
    monkeypatch.setattr(FSRecord, "discover", staticmethod(counting_discover))

    t0 = time.perf_counter()
    resolved = [
        claude_projects.existing_project_record_id(cwd) for cwd in project_corpus[:LOOKUPS]
    ]
    elapsed = time.perf_counter() - t0

    # The lookups really resolved (guards against a no-op arm).
    assert sum(1 for r in resolved if r) == LOOKUPS

    assert calls["n"] <= 1, (
        f"{LOOKUPS} project lookups enumerated the {CORPUS}-record corpus "
        f"{calls['n']} times ({elapsed * 1000:.0f}ms, "
        f"{elapsed / LOOKUPS * 1000:.1f}ms per lookup). Identity resolution is "
        f"O(refs x corpus): the corpus must be indexed once per pass and looked "
        f"up by cwd."
    )


# do not increase timeout without approval
@pytest.mark.timeout(30)
def test_project_index_sees_an_in_place_record_rewrite(project_corpus):
    """A record rewritten in place must not keep resolving under its old path.

    Rewriting an EXISTING record touches only its own metadata.json, which does
    NOT move the type directory's mtime — so a cache keyed on that mtime alone
    would serve the stale record for the life of the process. `FSRecord.save`
    bumps a per-type write generation that the stamp also reads.
    """
    from flow_sdk.fs_store.indexer.functions import claude_projects

    moved, other = project_corpus[0], project_corpus[1]
    record_id = claude_projects.existing_project_record_id(moved)
    assert record_id, "fixture record must resolve before the rewrite"

    # Warm the index, then re-point that record at a new cwd, in place.
    claude_projects.existing_project_record_id(other)
    record = claude_projects._find_project_record_by_cwd(moved)
    relocated = str(pathlib.Path(moved).parent / "relocated")
    pathlib.Path(relocated).mkdir()
    object.__setattr__(record, "cwd", relocated)
    object.__setattr__(record, "name", relocated)
    record.save()

    assert claude_projects.existing_project_record_id(relocated) == record_id
    assert claude_projects.existing_project_record_id(moved) is None, (
        "the old cwd still resolves — the index did not see an in-place rewrite"
    )
