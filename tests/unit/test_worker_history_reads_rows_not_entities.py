"""Worker history never builds every process; only the processes behind the rows it returns.

Perf hunt 2026-11-07 (B2): the UI asks for history on every project switch, and each call
built all ~1,400 processes (Pydantic + FsRef path resolution) to read a few fields, blocking the
event loop ~0.3 s. It reads stored rows now; the rows it returns are built for naming, in one
``$IN`` query. Counts, not milliseconds: a spy on ``AgenticProcess.get_all`` sees every build.
"""

from __future__ import annotations

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin import worker_history
from flow_sdk.builtin.agentic_process import AgenticProcess


async def test_history_builds_only_the_processes_it_returns(monkeypatch):
    named = AgenticProcess(id=mint_uuid(), session_id="returned", name="Kept name", workdir="/repo/a",
                           worker_type="claude_code")
    await named._db.save(named)
    for i in range(20):
        other = AgenticProcess(id=mint_uuid(), session_id=f"other-{i}", workdir="/repo/b", worker_type="claude_code")
        await other._db.save(other)

    filters: list = []
    real = AgenticProcess.get_all.__func__

    async def spy(cls, entities_filter=None, source_entity=None):
        filters.append(entities_filter)
        return await real(cls, entities_filter, source_entity)

    monkeypatch.setattr(AgenticProcess, "get_all", classmethod(spy))

    rows = await worker_history._load_agentic_processes()
    assert {r.session_id for r in rows} >= {"returned", "other-0"}
    assert filters == [], "the index is read from stored rows, not built entities"

    entry = worker_history.WorkerHistoryEntry(
        worker_type=worker_history.WorkerType.CLAUDE, worker_id="returned", agentic_process_id=str(named.id),
        last_active_time="2026-11-07T00:00:00Z",
    )
    await worker_history._project_history_names([entry])
    assert entry.name == "Kept name"
    assert len(filters) == 1 and filters[0]["match"]["operands"] == ["id", [str(named.id)]]
