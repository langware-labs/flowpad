"""Named steps run as an activity's children (``flow_sdk/activity/steps``): the outline first, then each
step started and ended in order; a failing step fails only itself and is raised, the rest stay pending."""

from __future__ import annotations

import pytest

from flow_sdk.activity import Activity, ActivityState, monitor
from flow_sdk.activity.steps import Step, announce, run_steps

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

SUBJECT = "agent-11111111-1111-4111-8111-111111111111"


@pytest.fixture(autouse=True)
def _clean_monitor():
    monitor.clear()
    yield
    monitor.clear()


async def test_steps_run_in_order_and_a_failure_ends_only_its_own_step():
    ran: list[str] = []

    async def note(name: str) -> None:
        ran.append(name)

    async def boom() -> None:
        raise RuntimeError("the hub refused")

    root = Activity.get("job", subject_entity=SUBJECT)
    steps = [Step("a", "Step A", lambda: note("a")), Step("b", "Step B", boom), Step("c", "Step C", lambda: note("c"))]
    announce(root, steps)
    outline = [(c.name, c.label, c.state) for c in root.spec().children]

    with pytest.raises(RuntimeError, match="the hub refused"):
        await run_steps(root, steps)

    assert outline == [(s.name, s.label, ActivityState.PENDING) for s in steps], "the outline is on before any runs"
    states = [(c.name, c.state, c.message) for c in root.spec().children]
    assert states == [
        ("a", ActivityState.COMPLETED, None),
        ("b", ActivityState.FAILED, "the hub refused"),
        ("c", ActivityState.PENDING, None),
    ]
    assert ran == ["a"] and not root.is_terminal, "ending the root is the caller's"
