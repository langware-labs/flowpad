"""``Job.get_all`` merges the API-visible system jobs into the user's jobs; a page of that merge must be
a page — no system job repeated on every page, never more rows than the limit, every row once across
the walk, in the database's order (newest first, ``id`` settling ties).

Real DB, no mocks (session SQLite fixture from tests/conftest.py).
"""

from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.faas.job import Job
from flow_sdk.builtin.faas.system_job import SystemJob
from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


async def test_a_paged_job_list_holds_each_system_job_once():
    tag = uuid.uuid4().hex[:8]
    mine = [f"user-{tag}-{i}" for i in range(3)]
    for name in mine:
        await Job(job_name=name).save(notify=False)
    await SystemJob(job_name=f"system-{tag}", allowed_api_execution=True).save(notify=False)

    match = ExpressionNode(op=QueryOp.IN, operands=["job_name", mine])
    everything = await Job.get_all(QueryFilter(type=Job.get_type(), match=match))
    system_names = {j.job_name for j in everything} - set(mine)
    assert f"system-{tag}" in system_names

    walked, offset = [], 0
    while True:
        page = await Job.get_all(QueryFilter(type=Job.get_type(), match=match, limit=2, offset=offset or None))
        assert len(page) <= 2, f"a page ran past its limit: {[j.job_name for j in page]}"
        walked += [j.job_name for j in page]
        if len(page) < 2:
            break
        offset += 2
    assert sorted(walked) == sorted(j.job_name for j in everything), "rows repeated or lost across pages"
    # Newest first: the user jobs (system jobs carry no created_date, so they lead, as nulls do descending).
    assert [n for n in walked if n in mine] == list(reversed(mine))
