"""The bridge from contract sources to the old engine lived only inside the cutover branch.

Inverted at the engine swap (D1): the engine traverses contract sources directly, so the old driver
surface and the bridge are gone and must stay gone.
"""
from __future__ import annotations

from importlib.util import find_spec


def test_the_old_driver_surface_and_the_bridge_are_gone():
    for module in ("flow_sdk.ingest.driver", "flow_sdk.ingest.source_driver", "flow_sdk.ingest.spec_registry", "flow_sdk.ingest.drivers"):
        assert find_spec(module) is None, f"{module} came back"
