"""Tests for Record.identity_key — deterministic id derivation at construction time."""

from __future__ import annotations

import uuid

from flow_sdk.fs_store.record import Record


class FixedKeyRecord(Record):
    """Subclass that returns a fixed identity_key, enabling deterministic ids."""

    _record_type = "test_fixed"

    @property
    def identity_key(self) -> str | None:
        return "my-stable-key"


class NameKeyRecord(Record):
    """Subclass that derives identity_key from the 'name' field."""

    _record_type = "test_name_key"

    @property
    def identity_key(self) -> str | None:
        return object.__getattribute__(self, "__dict__").get("name")


class DefaultRecord(Record):
    """Subclass that uses the default identity_key (None → uuid4)."""

    _record_type = "test_default"


# ---------------------------------------------------------------------------
# identity_key via __init__
# ---------------------------------------------------------------------------


def test_fixed_key_produces_deterministic_id():
    """Two instances with the same identity_key and no explicit id get the same id."""
    r1 = FixedKeyRecord()
    r2 = FixedKeyRecord()
    assert r1.id == r2.id


def test_fixed_key_id_is_uuid5():
    """The derived id is a valid UUID5 computed from record_type:identity_key."""
    r = FixedKeyRecord()
    expected = str(uuid.uuid5(uuid.NAMESPACE_DNS, "test_fixed:my-stable-key"))
    assert r.id == expected


def test_explicit_id_overrides_identity_key():
    """Passing an explicit id to __init__ takes precedence over identity_key."""
    explicit_id = str(uuid.uuid4())
    r = FixedKeyRecord(id=explicit_id)
    assert r.id == explicit_id


def test_default_identity_key_produces_random_id():
    """Default identity_key (None) falls back to uuid4 — ids are not stable."""
    r1 = DefaultRecord()
    r2 = DefaultRecord()
    assert r1.id != r2.id  # vanishingly unlikely to collide


def test_name_key_record_deterministic():
    """identity_key derived from a data field produces stable ids."""
    r1 = NameKeyRecord(name="hello")
    r2 = NameKeyRecord(name="hello")
    assert r1.id == r2.id


def test_name_key_record_different_names():
    """Different identity_key values produce different ids."""
    r1 = NameKeyRecord(name="alpha")
    r2 = NameKeyRecord(name="beta")
    assert r1.id != r2.id


# ---------------------------------------------------------------------------
# identity_key via from_dict
# ---------------------------------------------------------------------------


def test_from_dict_with_existing_id_preserved():
    """from_dict preserves an id already present in the dict."""
    existing_id = str(uuid.uuid4())
    r = FixedKeyRecord.from_dict({"id": existing_id})
    assert r.id == existing_id


def test_from_dict_no_id_uses_identity_key():
    """from_dict without an id falls back to identity_key-derived uuid5."""
    r = FixedKeyRecord.from_dict({})
    expected = str(uuid.uuid5(uuid.NAMESPACE_DNS, "test_fixed:my-stable-key"))
    assert r.id == expected


def test_from_dict_default_record_random_id():
    """from_dict on a default (no identity_key) record assigns a random uuid4."""
    r1 = DefaultRecord.from_dict({})
    r2 = DefaultRecord.from_dict({})
    assert r1.id != r2.id
