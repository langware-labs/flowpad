"""``source_step:<source id>:<step>`` -- a data source's setup step, answered in-process.

A setup gate asks it every few seconds while a phone sends a code; through the ``flow`` CLI that took a minute
per look on a slow Windows machine. In-process it is one call.
"""
from __future__ import annotations

import pytest

from flow_sdk.core.status.check import UnknownStatusFact, check_fact
from flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue

pytestmark = pytest.mark.timeout(5)  # do not increase without approval


class _Source:
    def __init__(self, ok: bool):
        self.ok, self.steps = ok, []

    async def step(self, name):
        self.steps.append(name)
        return ReturnedValue.satisfied("connected") if self.ok else ReturnedValue.not_yet("Not connected yet.")


@pytest.mark.parametrize("ok", [True, False])
async def test_the_fact_is_the_steps_own_answer(monkeypatch, ok):
    from flow_sdk.builtin.data_source import DataSource

    source = _Source(ok)

    async def get_by_id(cls, source_id):
        return source if source_id == "s1" else None

    monkeypatch.setattr(DataSource, "get_by_id", classmethod(get_by_id))
    held, detail = await check_fact("source_step:s1:connected")
    assert (held, source.steps) == (ok, ["connected"])
    assert detail == ("connected" if ok else "Not connected yet.")
    assert await check_fact("source_step:gone:connected") == (False, "no data source gone")


async def test_a_fact_without_a_step_is_refused():
    with pytest.raises(UnknownStatusFact):
        await check_fact("source_step:s1")
