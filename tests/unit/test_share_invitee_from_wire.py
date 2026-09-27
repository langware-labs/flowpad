"""``ShareInvitee.from_wire`` — the two accepted ``recipients`` entry shapes.

Regression: classifying ``idOrEmail`` by trying ``normalize_email`` first
would always win, because it has no ``@`` check and only rejects an empty
string — so a bare hub UUID would be misfiled as an email. The fix tries
``recipient_user_id`` (a real UUID/typeid check) first and falls back to
email only when that fails.
"""
from __future__ import annotations

import pytest

from flow_sdk.app.actions.share_action import ShareInvitee

GADI = "090ffc4d-af90-4d74-9514-aa8650abca7a"


def test_bare_email_string_is_the_original_flat_shape():
    inv = ShareInvitee.from_wire("Noa@Langware.ai")
    assert inv.email == "noa@langware.ai"
    assert inv.user_id is None
    assert inv.role is None


def test_bare_uuid_string_is_classified_as_a_user_id_not_an_email():
    """THE BUG: naive email-first detection accepts anything non-empty."""
    inv = ShareInvitee.from_wire(GADI)
    assert inv.user_id == GADI
    assert inv.email is None


def test_bare_user_typeid_string_is_classified_as_a_user_id():
    inv = ShareInvitee.from_wire(f"user-{GADI}")
    assert inv.user_id == GADI
    assert inv.email is None


def test_object_shape_carries_a_role_for_an_email_recipient():
    inv = ShareInvitee.from_wire({"idOrEmail": "noa@langware.ai", "role": "admin"})
    assert inv.email == "noa@langware.ai"
    assert inv.role == "admin"


def test_object_shape_carries_a_role_for_a_user_id_recipient():
    inv = ShareInvitee.from_wire({"idOrEmail": GADI, "role": "admin"})
    assert inv.user_id == GADI
    assert inv.role == "admin"


@pytest.mark.parametrize("bad", [{"idOrEmail": "x", "email": "y"}, {"user_id": "x"}, {}])
def test_object_shape_rejects_unknown_or_missing_fields(bad):
    with pytest.raises(ValueError):
        ShareInvitee.from_wire(bad)


@pytest.mark.parametrize("bad", [123, None, ["noa@langware.ai"]])
def test_rejects_a_shape_that_is_neither_string_nor_object(bad):
    with pytest.raises(ValueError):
        ShareInvitee.from_wire(bad)
