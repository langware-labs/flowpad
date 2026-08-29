"""``HubSerializer`` — the body POSTed to the hub is the non-PRIVATE, non-HUB_READ
field set, JSON-serializable, and rehydrates; a disk-only field raises."""
from __future__ import annotations

import json
from typing import Optional

import pytest

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.dataset import Dataset
from flow_sdk.builtin.db_origin import HubOrigin
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.fs_store.serializer import UnsupportedFieldError
from flow_sdk.fs_store.serializer.hub import HubSerializer
from flow_sdk.schema.data_spec.dataset_spec import FileRef
from tests.unit.test_data_spec._roundtrip import populate

pytestmark = pytest.mark.timeout(5)  # do not increase without approval


@pytest.mark.parametrize("cls", [Agent, Dataset])
def test_the_hub_body_is_hub_body_and_rehydrates(cls: type) -> None:
    e = populate(cls)
    body = HubSerializer().body(e)
    assert body == e._hub_body()                                # _hub_body delegates here
    json.dumps(body)                                            # JSON-serializable
    assert "asset_ref" not in body                              # PRIVATE never leaves the machine
    back = HubSerializer.from_payload(cls, body)
    for name in body:
        assert getattr(back, name) == getattr(e, name), name


def test_a_disk_only_field_not_excluded_by_sharing_raises() -> None:
    class _WithFile(Entity):
        type: str = APIField(default="probe_hub_with_file")
        scan: Optional[FileRef] = APIField(default=None)

    with pytest.raises(UnsupportedFieldError, match="hub body"):
        HubSerializer().body(_WithFile(scan=FileRef(path="a.pdf")))


def test_store_returns_the_origin_with_the_url_key() -> None:
    a = Agent(name="q")
    assert HubSerializer().store(a, HubOrigin()).id == a.id
