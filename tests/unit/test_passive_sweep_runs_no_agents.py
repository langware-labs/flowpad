"""A background capability sweep refreshes badges; it does not run work.

``_mirror_to_rows`` called ``registry.test(kind)`` for every discovered
capability, to keep the UI's badges fresh. That is right for the ordinary
capability, whose ``test()`` shells out to ``--version`` or reads a token file.

It is wrong for ``chrome_authenticated``, whose ``test()`` drives a REAL Claude
agent through a browse-and-report round trip. Every ``GET
/graph/capabilities/summary`` therefore launched a vendor CLI and waited on it —
a badge refresh costing a live agent run. It stayed merely wasteful until
start_pty began copying the launch's outputs back onto the caller, at which
point the caller had a real session to wait on and the wait became a hang:
test_capabilities_summary_groups_by_intent went from 12s to blowing its 30s cap.

``sweepable_test`` is the seam. These pin both halves of it, so a new
expensive probe cannot quietly rejoin the sweep.
"""

from __future__ import annotations

import pytest

from flow_sdk.core.capabilities.models import CapabilityKind
from flow_sdk.core.capabilities.registry import get_capability_registry

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(5)


def test_the_chrome_probe_is_not_swept():
    """It drives a real agent — only an explicit user verb may run it."""
    spec = get_capability_registry().get(CapabilityKind.CHROME_AUTHENTICATED.value).spec
    assert spec.sweepable_test is False


def test_ordinary_capabilities_are_still_swept():
    """The flag is an exception, not a new default — badges must stay fresh."""
    registry = get_capability_registry()
    sweepable = [k for k in registry.kinds() if registry.get(k).spec.sweepable_test]
    assert len(sweepable) > 5, "the sweep should still cover the ordinary capabilities"
    assert CapabilityKind.CLAUDE_CLI.value in sweepable


def test_every_unsweepable_capability_is_deliberate():
    """A capability opts OUT only for a stated reason.

    Guards the direction of drift that actually hurts: a cheap probe marked
    unsweepable silently stops refreshing its badge, and nothing fails. Keeping
    the exception list explicit means adding to it is a decision someone makes
    on purpose.
    """
    registry = get_capability_registry()
    unsweepable = {k for k in registry.kinds() if not registry.get(k).spec.sweepable_test}
    assert unsweepable == {CapabilityKind.CHROME_AUTHENTICATED.value}, (
        "a capability was newly excluded from the passive sweep. That is right only if its "
        "test() spawns a process, drives an agent or spends tokens — if it is cheap and "
        "offline, leave it swept so its badge stays fresh. Update this test when you mean it."
    )
