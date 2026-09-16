"""``app.ready`` — the event, its forwarding, and the order it is emitted in.

The ordering test is the one that matters. ``_app_ready_signal`` waits for the
bootstrap, then awaits the detached system-content index, then reconciles the
wizard triggers, and only then emits. Steps 2 and 3 are what make the event mean
anything: a wizard shipped in a system project is discovered ONLY by that
detached walk, and the bus has no durability — an unarmed subscriber at emit
time does not get the event late, it never gets it at all, and nothing anywhere
would say why the wizard did not run.
"""
import asyncio

import pytest

from flow_sdk.builtin.tag import RESERVED_ROOTS, SYSTEM_TAG_SEED
from flow_sdk.tags.bus import validate_bus_pattern
from flow_sdk.tags.grammar import normalize_tag
from flow_sdk.tags.ws_forward import FORWARDED_TAG_PATTERNS

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

TAG = "app.ready"


def test_the_tag_is_a_legal_segment_and_a_legal_pattern():
    assert normalize_tag(TAG) == TAG
    assert validate_bus_pattern(TAG) is None


def test_it_is_seeded_in_the_shipped_vocabulary():
    assert TAG in {name for name, _title, _desc in SYSTEM_TAG_SEED}


def test_it_stays_under_an_already_reserved_root():
    """A new root would force an edit to the TS mirror and the contract fixture.
    A leaf under `app` costs neither."""
    assert "app" in RESERVED_ROOTS


def test_it_reaches_the_client():
    assert TAG in FORWARDED_TAG_PATTERNS


def test_it_is_forwarded_as_an_exact_tag_not_a_glob():
    """It fires once per boot; a glob here would put a whole family on the wire."""
    assert "*" not in TAG


@pytest.mark.asyncio
async def test_the_emit_waits_for_bootstrap_then_the_index_then_the_arming(monkeypatch):
    from flow_sdk.server import app as server_app

    order: list[str] = []
    served = asyncio.Event()

    async def _index() -> None:
        await served.wait()
        order.append("index")

    async def _reconcile() -> None:
        order.append("reconcile")

    def _publish(event):
        order.append("emit")
        return event

    monkeypatch.setattr(server_app, "_system_content_index_task", asyncio.ensure_future(_index()))
    monkeypatch.setattr(
        "flow_sdk.server.builtin_triggers.reconcile_wizard_triggers", _reconcile
    )
    monkeypatch.setattr("flow_sdk.tags.bus.publish_tag", _publish)

    from flow_sdk.server.routes.bootstrap import first_bootstrap_served

    was_set = first_bootstrap_served.is_set()
    first_bootstrap_served.clear()
    try:
        signal = asyncio.ensure_future(server_app._app_ready_signal())
        await asyncio.sleep(0)
        assert order == [], "nothing may happen before a bootstrap has been served"

        first_bootstrap_served.set()
        served.set()
        await asyncio.wait_for(signal, timeout=3)
    finally:
        if was_set:
            first_bootstrap_served.set()

    assert order == ["index", "reconcile", "emit"], (
        "the wizard's trigger must be armed BEFORE the event it waits for is emitted"
    )
