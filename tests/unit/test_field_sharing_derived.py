"""P2 — the derived sets must equal today's hand-maintained literals, per class.

This is the guard that makes the whole consolidation safe, and it is deliberately
CLASS-LEVEL: no instances, no ``model_dump``, no ``exclude_none``. Both egress
seams drop None-valued fields, so an instance-based check cannot see a field that
happens to be unset — and a missed annotation on a None-defaulted field
(``asset_ref``, ``cwd``, ``installed_root``, ``git_origin`` are all this shape) is
exactly the silent leak this refactor risks.

Note the failure mode INVERTS with this work. Today a stale name in one of the
literals is a harmless no-op, because ``model_dump(exclude={unknown})`` ignores
names the model doesn't have. Once the sets are derived from declarations, a
field nobody annotated simply travels. Hence: every Entity subclass, every
boundary, compared against the literal that governs it today.

TWO DIVERGENCES ARE EXPECTED AND NAMED
    The lists below are the deliberate behaviour changes this work makes, held
    here as explicit exceptions so they are reviewed rather than absorbed. Each is
    deleted by the phase that lands it, at which point the assertions become
    plain equality.
"""

from __future__ import annotations

import pytest

import flow_sdk.models.entities  # noqa: F401  — imports every entity module
from flow_sdk.core.entity.entity_model import Entity

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

# P4 will stop pushing these to the hub. Today the bundle seam strips them while
# `_hub_body` still sends them — local paths the hub has no use for, which is why
# the receiver defends with `sanitized.pop("asset_ref")`. One `Sharing` value per
# field cannot express both, so annotating them PRIVATE reads as "not sent to the
# hub" before the consumer flips.
CONVERGENCE_PENDING_HUB_PUSH = frozenset({
    "asset_ref", "scope", "path", "cwd", "installed_root", "fs_storage_mount_path", "expand",
    # Task's `TypeInfo.local_fields`, same shape: bundle-stripped, hub-sent.
    "my_process_id", "project_root", "project_name",
})

# `HUB_AUTHORITATIVE_FIELDS` is only `updated_date` — the LWW clock, where a local
# re-stamp runs the comparison ahead and masks real hub changes. `created_date` is
# equally hub-owned (never sent, always accepted) but was never listed, so
# `from_record` may re-stamp it. Deriving from HUB_READ protects it too; strictly
# safer, but a change, so it is named here until P3d reviews it.
CONVERGENCE_PENDING_HUB_OWNED = frozenset({"created_date"})


def _entity_classes() -> list[type[Entity]]:
    seen: dict[str, type[Entity]] = {}

    def walk(cls):
        for sub in cls.__subclasses__():
            seen.setdefault(f"{sub.__module__}.{sub.__qualname__}", sub)
            walk(sub)

    walk(Entity)
    return [Entity, *seen.values()]


def _declared(cls) -> set[str]:
    """Names this class actually has — the derived sets can only contain these."""
    return set(cls.model_fields) | set(cls.model_computed_fields)


ENTITY_CLASSES = _entity_classes()
IDS = [f"{c.__module__.rsplit('.', 1)[-1]}.{c.__name__}" for c in ENTITY_CLASSES]


def test_there_are_entity_classes_to_check():
    """A guard over an empty list passes vacuously — assert we actually walked."""
    assert len(ENTITY_CLASSES) > 50, f"only found {len(ENTITY_CLASSES)} entity classes"


@pytest.mark.parametrize("cls", ENTITY_CLASSES, ids=IDS)
def test_bundle_exclusion_matches_local_fields(cls):
    """`fields_not_in_bundle()` must reproduce `_local_fields()`."""
    declared = _declared(cls)
    today = {f for f in cls._BASE_LOCAL_FIELDS if f in declared}
    # Per-type additions live on TypeInfo; resolve them the way `_local_fields` does.
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    info = SchemaRegistry.get(cls.get_type()) if cls.get_type() else None
    today |= {f for f in (getattr(info, "local_fields", None) or ()) if f in declared}
    assert cls.fields_not_in_bundle() == today


@pytest.mark.parametrize("cls", ENTITY_CLASSES, ids=IDS)
def test_hub_push_exclusion_matches_the_hub_body_literal(cls):
    """`fields_not_sent_to_hub()` must reproduce `_hub_body`'s exclude literal."""
    declared = _declared(cls)
    today = {f for f in _HUB_BODY_LITERAL if f in declared}
    expected = today | (CONVERGENCE_PENDING_HUB_PUSH & declared)
    assert cls.fields_not_sent_to_hub() == expected


@pytest.mark.parametrize("cls", ENTITY_CLASSES, ids=IDS)
def test_hub_pull_protection_matches_local_only_fields(cls):
    """`fields_not_accepted_from_hub()` must reproduce `LOCAL_ONLY_FIELDS`."""
    declared = _declared(cls)
    today = {f for f in cls.LOCAL_ONLY_FIELDS if f in declared}
    # PRIVATE also blocks ingress, so every bundle-private field is protected too.
    expected = today | (cls.fields_not_in_bundle() & declared)
    assert cls.fields_not_accepted_from_hub() >= expected
    # ...and nothing beyond PRIVATE ∪ HUB_WRITE may be blocked.
    assert cls.fields_not_accepted_from_hub() <= declared


@pytest.mark.parametrize("cls", ENTITY_CLASSES, ids=IDS)
def test_hub_owned_matches_hub_authoritative_fields(cls):
    """`fields_owned_by_hub()` must reproduce `HUB_AUTHORITATIVE_FIELDS`."""
    declared = _declared(cls)
    today = {f for f in cls.HUB_AUTHORITATIVE_FIELDS if f in declared}
    assert cls.fields_owned_by_hub() == today | (CONVERGENCE_PENDING_HUB_OWNED & declared)


# The literal `Entity._hub_body` passes today. Kept here rather than imported so
# that deleting it in P5 forces this file to be updated deliberately.
_HUB_BODY_LITERAL = frozenset({
    "private_context_entities_", "private_context_entities", "private_context_entity_data",
    "shared_context_entity_data", "created_by", "updated_by", "created_date", "updated_date",
    "remote", "system", "fetched_at", "message_count", "git_origin", "asset_occurrences",
    "duplicate_count", "tags", "project_id", "members",
})
