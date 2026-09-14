"""The bridge from contract sources to the old engine exists only inside this branch.

Inverted at the engine swap (D1): then ``flow_sdk.ingest.driver`` and the bridge are gone.
"""
from __future__ import annotations

from importlib.util import find_spec


def test_the_bridge_is_marked_for_deletion_at_the_engine_swap():
    from flow_sdk.ingest import source_driver

    assert source_driver.DELETE_AT == "D1"
    assert find_spec("flow_sdk.ingest.driver") is not None, "the engine swap deleted the old surface: invert this test"
