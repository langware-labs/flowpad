"""Every shipped manifest that offers a picker has a driver that can fill it.

`DataDriverSpec` cannot check this itself: its validators are documented pure — no reads,
no registry, no network — and the answer lives in the driver registry. So the pairing is
proven here instead, which is the right layer anyway. A mismatch is a build-time mistake,
and this fails on the commit that makes it rather than on a user's first click, where all
they would see is a picker that is permanently, silently empty.

It is the same rule the manifest already enforces one level down for reflect modes: never
offer a person a choice the code cannot honour.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.schema.data_spec.data_driver_spec import DataDriverSpec

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

REPO = Path(__file__).resolve().parents[2]
MANIFESTS = sorted((REPO / "flow_sdk" / "system_projects").rglob("data_driver/*/data_driver.json"))


def test_the_shelf_of_manifests_is_actually_found():
    """A glob that matches nothing would make every assertion below vacuous."""
    assert len(MANIFESTS) >= 11, f"found only {len(MANIFESTS)} manifests under system_projects"


@pytest.mark.parametrize("path", MANIFESTS, ids=lambda p: p.parent.name)
def test_a_choosable_field_has_a_driver_that_can_list_it(path: Path):
    manifest = DataDriverSpec.model_validate(json.loads(path.read_text()))
    choosable = [name for name, field in (manifest.config or {}).items() if field.choices]
    if not choosable:
        return  # nine of the twelve ask for an address the user already knows

    driver = DataDriver.loaded(manifest.name)
    assert driver is not None, f"{manifest.name} declares choices but registers no driver"
    assert driver.offers_choices, (
        f"{manifest.name} marks {choosable} choosable, but its source class can list none "
        "(neither `choices` nor `choices_for`) — the form would offer a picker that can never fill"
    )
