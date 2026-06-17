"""Driver-level proof of remote-reflection mode.

When ``_REMOTE_REFLECTION`` is active the DB driver must mirror a hub-origin
row verbatim: ``created_by`` / ``updated_by`` are preserved EXACTLY as the
payload carries them — including ``None`` — instead of being substituted with
the local request user or the ``system`` sentinel. Timestamps (not identity)
are still defaulted so we never persist a null date. Without the var, normal
local stamping applies.

This is the on/off switch for the whole "receiver never fabricates attribution
on remote conversations/messages" cleanup.
"""

from __future__ import annotations

from types import SimpleNamespace

from flow_sdk.core.entity.entity_model import remote_reflection
from flow_sdk.db.drivers.db_driver import DBDriver
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType


def _record(**over):
    base = dict(
        type="flow_message",
        id="11111111-1111-4111-8111-111111111111",
        created_by=None,
        updated_by=None,
        created_date=None,
        updated_date=None,
        created_through=None,
        updated_through=None,
    )
    base.update(over)
    return SimpleNamespace(**base)


def test_create_reflection_preserves_null_created_by():
    """Reflection: a hub row with no created_by stays null — no local user, no
    'system'. created_date is still defaulted (timestamps are not identity)."""
    rec = _record(created_by=None, updated_by="hub-author")
    with remote_reflection():
        DBDriver.apply_create_fields(rec)
    assert rec.created_by is None
    assert rec.updated_by == "hub-author"  # verbatim, not clobbered
    assert rec.created_date is not None     # date defaulted, never null
    assert rec.updated_date is not None


def test_create_reflection_preserves_hub_created_by():
    rec = _record(created_by="hub-creator", updated_by="hub-creator")
    with remote_reflection():
        DBDriver.apply_create_fields(rec)
    assert rec.created_by == "hub-creator"
    assert rec.updated_by == "hub-creator"


def test_create_without_reflection_stamps_system_when_no_context():
    """Outside reflection mode, a null created_by is substituted (here 'system'
    since the unit test has no request context) — the legacy behavior."""
    rec = _record(created_by=None)
    DBDriver.apply_create_fields(rec)
    assert rec.created_by == "system"
    assert rec.updated_by == "system"


def test_update_reflection_does_not_clobber_updated_by():
    rec = _record(updated_by="hub-author", updated_date=None)
    with remote_reflection():
        DBDriver.apply_update_fields(rec)
    assert rec.updated_by == "hub-author"  # NOT the local sync user / 'unknown'
    assert rec.updated_date is not None


def test_update_without_reflection_stamps_updated_by():
    rec = _record(type="flow_message", updated_by="hub-author")
    DBDriver.apply_update_fields(rec)
    # No request context in the unit test → falls back to UnknownUserId.
    assert rec.updated_by == "unknown"
    assert rec.updated_by != "hub-author"
