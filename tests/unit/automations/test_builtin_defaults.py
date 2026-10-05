"""The Daily self-check is optional: it starts off, like the daily usage summary."""

from __future__ import annotations

import pytest

from flow_sdk.builtin.trigger import Trigger
from flow_sdk.graph_workflow_manager.service_graph_workflows import MINI_TRIGGER_SPEC, _mini_trigger
from tests.pytest_plugin import async_context

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


async def _clear():
    # The test DB is shared by the session; another test may have seeded it.
    for query in ({"uname": MINI_TRIGGER_SPEC["uname"]}, {"name": MINI_TRIGGER_SPEC["name"]},
                  {"name": "Mini analyzer (manual)"}):
        while (row := await Trigger.get_one(query)) is not None:
            await row.delete()


@async_context
async def test_a_fresh_install_seeds_it_off():
    await _clear()
    assert (await _mini_trigger()).enabled is False


@async_context
async def test_an_old_row_seeded_on_is_adopted_and_switched_off():
    await _clear()
    old = Trigger(name="Mini analyzer (manual)", trigger_type="schedule", sched_trigger_type="interval",
                  expr="24h", scope="system", enabled=True)
    await old.save()
    trigger = await _mini_trigger()
    assert (trigger.id, trigger.name, trigger.enabled) == (old.id, MINI_TRIGGER_SPEC["name"], False)
