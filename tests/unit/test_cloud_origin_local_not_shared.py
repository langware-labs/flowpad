"""A cached cloud record's LOCAL row ids must never leave this machine.

``FlowMessage.origin`` used to be one value object carrying both halves of a
cached record's provenance: the channel and permalink (meaningful anywhere) and
the DataSource / SourceItem row ids (meaningful only here). It declared no
``sharing=``, so it defaulted to ``Sharing.SHARED`` — and a bundle strips exactly
``PRIVATE``. Every shared message therefore shipped two ids that resolve nowhere
on the receiver, where ``inbox/outbound`` would dereference them, miss, and
report the record as *deleted* rather than *foreign*.

The fix splits the object rather than hiding it: ``origin`` keeps the
transportable half so a received message still renders its channel badge and
"Open in ..." link, and ``origin_local`` carries the row ids under ``PRIVATE``.

The golden sharing test pins the POLICY. This pins the PAYLOAD — the two fail
for different reasons, and a regression that reunited the halves would slip past
a policy-only assertion.
"""

from __future__ import annotations

import json

import pytest

import flow_sdk.models.entities  # noqa: F401 — registers the entity types
from flow_sdk.builtin.cloud_origin import CloudOrigin, CloudOriginLocal
from flow_sdk.builtin.flow_message import FlowMessage

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

_DS_ID = "11111111-1111-4111-8111-111111111111"
_ITEM_ID = "22222222-2222-4222-8222-222222222222"


def _message() -> FlowMessage:
    return FlowMessage(
        text="hello",
        origin=CloudOrigin(
            kind="gmail",
            provider="agent",
            external_id="msg-abc",
            url="https://mail.google.com/mail/u/0/#inbox/msg-abc",
        ),
        origin_local=CloudOriginLocal(data_source_id=_DS_ID, source_item_id=_ITEM_ID),
    )


def test_local_half_is_declared_private_and_the_shared_half_is_not():
    fm = _message()
    local = fm._local_fields()
    assert "origin_local" in local
    assert "origin" not in local


def test_hub_body_carries_the_badge_but_not_the_row_ids():
    body = _message()._hub_body()

    assert "origin_local" not in body
    origin = body.get("origin") or {}
    # The half the receiver actually renders survives.
    assert origin.get("kind") == "gmail"
    assert origin.get("url", "").startswith("https://")

    # Nothing anywhere in the payload — not just at the top level — carries a
    # local row id. Serialized whole because a future nesting change must fail
    # here rather than quietly reintroduce the leak one level down.
    blob = json.dumps(body, default=str)
    assert _DS_ID not in blob
    assert _ITEM_ID not in blob


def test_cloud_origin_no_longer_declares_the_local_ids():
    """The split is structural, so a caller cannot re-add them by accident."""
    assert "data_source_id" not in CloudOrigin.model_fields
    assert "source_item_id" not in CloudOrigin.model_fields
    assert set(CloudOriginLocal.model_fields) == {"data_source_id", "source_item_id"}


def test_a_row_written_before_the_split_keeps_its_local_ids():
    """The ids used to live inside `origin`; parsing must not drop them.

    A re-poll repairs any message still inside the provider's window. Nothing
    repairs one that has fallen out of it — so without the read-side lift, an
    older cached message becomes permanently unreplyable and reports itself as
    having been shared from another machine.
    """
    legacy = FlowMessage(
        text="hello",
        origin={
            "kind": "gmail",
            "provider": "agent",
            "external_id": "msg-abc",
            "url": "https://mail.google.com/",
            # the pre-split shape
            "data_source_id": _DS_ID,
            "source_item_id": _ITEM_ID,
        },
    )
    assert legacy.origin_local is not None
    assert legacy.origin_local.data_source_id == _DS_ID
    assert legacy.origin_local.source_item_id == _ITEM_ID
    # ...and the lift does not put them back on the wire.
    assert _DS_ID not in json.dumps(legacy._hub_body(), default=str)
