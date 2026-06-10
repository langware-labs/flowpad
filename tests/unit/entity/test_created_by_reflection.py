"""created_by reflection at the driver chokepoint.

A hub-materialized row is a pure reflection of the remote entity: when the
payload pre-sets ``created_by`` (the hub's ``initiated_by`` / the wire
``sender_id`` / the 'system' sentinel), ``apply_create_fields`` must preserve
it — never re-stamp the local request-context user. That re-stamp is how a
received conversation surfaced in the UI as created by the recipient
("from <local git user.name>").
"""

from __future__ import annotations

import pytest

from flow_sdk.builtin.conversation import Conversation
from flow_sdk.db.drivers.db_driver import DBDriver
from flow_sdk.flowpad_types.enums.auth_enums import BuiltInConstant

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


def test_preset_created_by_is_preserved():
    """Remote creator carried in the payload survives the create stamp."""
    conv = Conversation.model_validate({"id": "c-1", "created_by": "remote-sender-id"})
    DBDriver.apply_create_fields(conv)
    assert conv.created_by == "remote-sender-id"
    # updated_by mirrors the (preserved) creator — still no local identity.
    assert conv.updated_by == "remote-sender-id"


def test_unset_created_by_defaults_to_system_outside_requests():
    """No payload creator + no request context → the neutral sentinel."""
    conv = Conversation.model_validate({"id": "c-2"})
    DBDriver.apply_create_fields(conv)
    assert conv.created_by == BuiltInConstant.SystemUserId.value
