"""The ``task_manager`` source's case in the data source matrix: the Tasks channel of one principal.

Nothing is fetched — its items are the ledger's own ``task.*`` events, fed by the bus — so a sync
ingests none. A send is the principal's reply on one of its tasks: the ledger's ``replied`` event.
The task's owner is another agent, never a subagent, so no run is dispatched for it.
"""
from __future__ import annotations

from contextlib import contextmanager

from flow_sdk.api.api_types.identifier import mint_uuid

PRINCIPAL = f"agent:{mint_uuid()}"


@contextmanager
def case(monkeypatch, tmp_path):
    async def prepare(_source_id: str) -> dict:
        from flow_sdk.tasks import ledger  # noqa: PLC0415

        task = await ledger.create(title="Matrix task", brief="Reply on me.", creator=PRINCIPAL,
                                   owner=f"agent:{mint_uuid()}")
        return {"send": {"to": task.id, "thread_key": task.id, "text": "matrix send"}}

    yield {"config": {"principal": PRINCIPAL}, "min_items": 0, "prepare": prepare,
           "send": {"to": "set by prepare", "text": "matrix send"}}
