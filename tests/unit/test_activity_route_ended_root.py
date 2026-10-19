"""A verb sent to a root that has already ended must not mint a phantom root.

The monitor evicts a root at its terminal, so the address is free again. A QA manager that
failed its cycle's root and then reported ``resume`` on it got ``ok`` back — the route's
``Activity.get`` minted a fresh, unlabelled root, ``resume`` set it running, and the footer
showed that orphan as running forever: nothing would ever end a root nobody planned.
"""

import pytest

from flow_sdk.activity import Activity, monitor
from flow_sdk.server.routes.activity import VerbBody, report

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

ROOT = "qa-cycle"


async def test_resume_on_an_ended_root_is_refused_and_leaves_no_live_root():
    cycle = Activity.get(ROOT)
    cycle.label("Full QA cycle")
    cycle.plan([{"name": "p01"}, {"name": "p02"}])
    await report(ROOT, "fail", VerbBody(message="halted"))

    resp = await report(ROOT, "resume", VerbBody())

    assert str(resp.status).lower() == "fail" and resp.data["error_code"] == "NOT_LIVE", resp
    assert monitor.get(ROOT) is None, f"phantom root left running: {monitor.get(ROOT)}"
