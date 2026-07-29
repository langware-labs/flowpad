"""P1 — the `Sharing` contract as a matrix: every value × every boundary.

`Sharing` replaces six hand-maintained name lists with one per-field declaration.
This file states the whole contract against the collector directly, on a
throwaway model — so all of it is provable before a single production seam is
rewired, and a wrong cell is a failing assertion rather than a field that quietly
starts (or stops) travelling.

The two rows that are easy to forget, and both of which have already bitten:

* an UNDECLARED field must resolve `SHARED`, or every existing declaration in the
  codebase silently changes meaning the moment the flag is introduced;
* a COMPUTED field must be honoured — those live in `model_computed_fields`, a
  different dict from `model_fields`, and two of them (`duplicate_count`,
  `private_context_entities`) are stripped at both egress seams today. A
  collector that loops only `model_fields` leaks them.
"""

from __future__ import annotations

from typing import ClassVar, Optional

import pytest
from pydantic import computed_field

from flow_sdk.api.api_types.api_field import APIField, Sharing, is_portable, sharing_policy
from flow_sdk.db.drivers.db_base_record import DBBaseRecord, clear_sharing_cache

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


class _Probe(DBBaseRecord):
    """One field per case. Deliberately not an Entity — the policy belongs to the
    field mechanism, not to any type that happens to use it.

    ``_abstract`` keeps ``__init_subclass__`` from registering a junk ``_probe``
    type in the global ``SchemaRegistry``; without it a throwaway test model
    pollutes every later test in the session.
    """

    _abstract: ClassVar[bool] = True

    shared_f: Optional[str] = APIField(None)  # undeclared ⇒ SHARED
    explicit_shared_f: Optional[str] = APIField(None, sharing=Sharing.SHARED)
    hub_write_f: Optional[str] = APIField(None, sharing=Sharing.HUB_WRITE)
    hub_read_f: Optional[str] = APIField(None, sharing=Sharing.HUB_READ)
    private_f: Optional[str] = APIField(None, sharing=Sharing.PRIVATE)

    # NOTE the decorator-argument form. Setting `.json_schema_extra` on the
    # property afterwards does NOT reach the `ComputedFieldInfo` — the policy is
    # silently lost, which is exactly what this case exists to catch.
    @computed_field(json_schema_extra={"sharing": str(Sharing.PRIVATE)})
    @property
    def computed_private_f(self) -> str:
        return "x"


@pytest.fixture(autouse=True)
def _fresh_cache():
    clear_sharing_cache()
    yield
    clear_sharing_cache()


# name → (sharing, sent to hub?, accepted from hub?, hub owns it?, in bundle?)
CASES = {
    "shared_f": (Sharing.SHARED, True, True, False, True),
    "explicit_shared_f": (Sharing.SHARED, True, True, False, True),
    "hub_write_f": (Sharing.HUB_WRITE, True, False, False, True),
    "hub_read_f": (Sharing.HUB_READ, False, True, True, True),
    "private_f": (Sharing.PRIVATE, False, False, False, False),
}


def test_every_sharing_value_has_a_case():
    """Coverage gate: a fifth value fails here until its row and boundaries exist."""
    assert {c[0] for c in CASES.values()} == set(Sharing)


@pytest.mark.parametrize("name", sorted(CASES))
def test_the_declared_value_is_what_the_reader_returns(name):
    expected = CASES[name][0]
    assert sharing_policy(_Probe.model_fields[name]) is expected


@pytest.mark.parametrize("name", sorted(CASES))
def test_boundaries_per_value(name):
    _, to_hub, from_hub, hub_owns, in_bundle = CASES[name]
    assert (name not in _Probe.fields_not_sent_to_hub()) is to_hub
    assert (name not in _Probe.fields_not_accepted_from_hub()) is from_hub
    assert (name in _Probe.fields_owned_by_hub()) is hub_owns
    assert (name not in _Probe.fields_not_in_bundle()) is in_bundle


def test_an_undeclared_field_is_shared():
    """The default has to be SHARED or introducing the flag rewrites every
    existing declaration's meaning."""
    assert sharing_policy(_Probe.model_fields["shared_f"]) is Sharing.SHARED
    assert is_portable(_Probe.model_fields["shared_f"]) is True
    assert "shared_f" not in _Probe.fields_not_sent_to_hub()


def test_a_computed_field_carries_policy_too():
    """`model_computed_fields` is a separate dict; a collector that misses it
    leaks `duplicate_count` and `private_context_entities`."""
    assert "computed_private_f" in _Probe.model_computed_fields
    assert "computed_private_f" not in _Probe.model_fields
    assert "computed_private_f" in _Probe.fields_not_sent_to_hub()
    assert "computed_private_f" in _Probe.fields_not_accepted_from_hub()
    assert "computed_private_f" in _Probe.fields_not_in_bundle()


def test_policy_is_inherited_by_subclasses():
    """Pydantic merges `model_fields`, so a subclass must see the base's policy
    without re-declaring it — that is what kills the old subclass-union drift
    (`FlowMessage.LOCAL_ONLY_FIELDS = Entity.LOCAL_ONLY_FIELDS | {...}`, where
    forgetting the union silently dropped the base's protections)."""

    class _Child(_Probe):
        _abstract: ClassVar[bool] = True
        own_private_f: Optional[str] = APIField(None, sharing=Sharing.PRIVATE)

    assert {"private_f", "own_private_f"} <= _Child.fields_not_sent_to_hub()
    assert "private_f" in _Probe.fields_not_sent_to_hub()
    assert "own_private_f" not in _Probe.fields_not_sent_to_hub()


def test_the_cache_is_per_class_not_inherited():
    """A class-attribute cache would let a subclass read its base's answer."""

    class _Other(_Probe):
        _abstract: ClassVar[bool] = True
        extra_private_f: Optional[str] = APIField(None, sharing=Sharing.PRIVATE)

    assert "extra_private_f" in _Other.fields_not_sent_to_hub()
    assert "extra_private_f" not in _Probe.fields_not_sent_to_hub()
