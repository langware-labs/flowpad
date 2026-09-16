"""A cached cloud record's LOCAL row ids must never leave this machine, and its identity
is the origin triple.

``FlowMessage.origin`` carries the transportable half — ``CloudOrigin(kind, namespace, key,
url)``, meaningful on any machine — and ``origin_local`` carries the DataDriver / SourceItem
row ids under ``PRIVATE``, which a bundle strips. Rows written before the triple (an
``external_id``, a ``provider``) and before the local/shared split (row ids inside
``origin``) still load: the message lifts the row ids into ``origin_local``, and the origin
lifts ``external_id`` into ``key`` and drops the rest.

The golden sharing test pins the POLICY. This pins the PAYLOAD.
"""

from __future__ import annotations

import json

import pytest

import flow_sdk.models.entities  # noqa: F401 — registers the entity types
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.fs_store.origin.cloud_origin import CloudOrigin, CloudOriginLocal
from flow_sdk.sources.values.origin import LEGACY_NAMESPACE

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

_DS_ID = "11111111-1111-4111-8111-111111111111"
_ITEM_ID = "22222222-2222-4222-8222-222222222222"


def _message() -> FlowMessage:
    return FlowMessage(
        text="hello",
        origin=CloudOrigin(kind="gmail", namespace="me@x", key="msg-abc", url="https://mail.google.com/mail/u/0/#inbox/msg-abc"),
        origin_local=CloudOriginLocal(data_source_id=_DS_ID, source_item_id=_ITEM_ID),
    )


def test_local_half_is_declared_private_and_the_shared_half_is_not():
    fm = _message()
    local = fm._local_fields()
    assert "origin_local" in local
    assert "origin" not in local


def test_hub_body_carries_the_identity_and_the_badge_but_not_the_row_ids():
    body = _message()._hub_body()

    assert "origin_local" not in body
    origin = body.get("origin") or {}
    assert (origin.get("kind"), origin.get("namespace"), origin.get("key")) == ("gmail", "me@x", "msg-abc")
    assert origin.get("url", "").startswith("https://")

    blob = json.dumps(body, default=str)
    assert _DS_ID not in blob
    assert _ITEM_ID not in blob


def test_cloud_origin_declares_the_triple_and_never_the_local_ids():
    assert set(CloudOrigin.model_fields) == {"kind", "namespace", "key", "url"}
    assert set(CloudOriginLocal.model_fields) == {"data_source_id", "source_item_id"}


def test_a_row_written_before_the_split_and_the_triple_still_loads():
    legacy = FlowMessage(
        text="hello",
        origin={
            "kind": "gmail",
            "provider": "agent",
            "external_id": "msg-abc",
            "url": "",
            # the pre-split shape
            "data_source_id": _DS_ID,
            "source_item_id": _ITEM_ID,
        },
    )
    assert legacy.origin_local is not None
    assert (legacy.origin_local.data_source_id, legacy.origin_local.source_item_id) == (_DS_ID, _ITEM_ID)
    assert legacy.origin is not None
    assert (legacy.origin.kind, legacy.origin.namespace, legacy.origin.key, legacy.origin.url) == (
        "gmail",
        LEGACY_NAMESPACE,
        "msg-abc",
        None,
    )
    assert _DS_ID not in json.dumps(legacy._hub_body(), default=str)
