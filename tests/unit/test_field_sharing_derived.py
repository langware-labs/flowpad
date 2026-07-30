"""Field-sharing policy is declared per field, uniformly — the standing guard.

The six hand-maintained name lists are gone (``_BASE_LOCAL_FIELDS``,
``TypeInfo.local_fields``, ``_hub_body``'s literal, ``LOCAL_ONLY_FIELDS`` and its
subclass unions, ``HUB_AUTHORITATIVE_FIELDS``, ``_STALE_IGNORE_FIELDS``). This
file replaces the migration guard that compared the derived sets against them,
and keeps the two invariants that made that guard worth having — both of which
caught real bugs while the consolidation was landing.

It is CLASS-LEVEL on purpose: no instances, no ``model_dump``, no
``exclude_none``. The egress seams drop None-valued fields, so an instance-based
check cannot see a field that happens to be unset, and the fields most likely to
be mis-declared (``asset_ref``, ``cwd``, ``installed_root``, ``git_origin``) are
exactly that shape.
"""

from __future__ import annotations

import pytest

import flow_sdk.models.entities  # noqa: F401  — imports every entity module
from flow_sdk.api.api_types.api_field import Sharing, sharing_policy
from flow_sdk.core.entity.entity_model import Entity

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

# Fields still declared with a bare pydantic ``Field`` / plain default, so they
# carry no policy and resolve to SHARED. Each needs a decision; they are listed
# rather than silently tolerated. Anything NOT here must be declared through the
# ``EntityField`` family — that is what makes the policy uniform instead of
# per-location.
#
# The ones already resolved and removed from this list: `fs_storage_provider`
# (Project popped it from the hub body by hand — the pop WAS the policy),
# `visitor_role` (a per-request auth projection), and User's `salt_` /
# `hashed_password_`, which had no policy at all and would have ridden a User
# share to the hub.
UNDECLARED_EXEMPT = frozenset({
    "env_vars",            # entity env vars — may legitimately travel with a shared agent
    "job_provider_type", "allowed_api_execution",  # Job/SystemJob runtime config
    "ga_client_id", "utm_params",                  # Visitor analytics
    "agent", "client_type",                        # Connection wire config
    "type",                                        # SystemJob re-declares the discriminator
})


def _entity_classes() -> list[type[Entity]]:
    seen: dict[str, type[Entity]] = {}

    def walk(cls):
        for sub in cls.__subclasses__():
            seen.setdefault(f"{sub.__module__}.{sub.__qualname__}", sub)
            walk(sub)

    walk(Entity)
    # Production classes only. Test modules define their own throwaway entities
    # with bare `Field`s, and they are not part of the app's field surface — in a
    # full-suite run they would otherwise be walked here and reported.
    return [Entity, *(c for c in seen.values() if c.__module__.startswith("flow_sdk."))]


ENTITY_CLASSES = _entity_classes()
IDS = [f"{c.__module__.rsplit('.', 1)[-1]}.{c.__name__}" for c in ENTITY_CLASSES]


def test_there_are_entity_classes_to_check():
    """A guard over an empty list passes vacuously — assert we actually walked."""
    assert len(ENTITY_CLASSES) > 50, f"only found {len(ENTITY_CLASSES)} entity classes"


@pytest.mark.parametrize("cls", ENTITY_CLASSES, ids=IDS)
def test_every_field_carries_a_policy(cls):
    """No field may be declared with a bare pydantic ``Field``.

    A bare declaration carries no ``sharing`` key at all, so it resolves to
    SHARED — it travels to the hub and into share bundles, and a reviewer reading
    the class sees nothing to suggest otherwise. That is how
    ``Entity.fs_storage_mount_path`` (a local mount path) and User's
    ``hashed_password_`` came to be shareable.
    """
    undeclared = sorted(
        name
        for name, info in cls.model_fields.items()
        if not (isinstance(info.json_schema_extra, dict) and "sharing" in info.json_schema_extra)
        and name not in UNDECLARED_EXEMPT
    )
    assert undeclared == [], (
        f"{cls.__name__}: declared with a bare pydantic Field, so they silently "
        f"resolve to SHARED: {undeclared}. Use APIField/EntityField with an "
        f"explicit `sharing=`, or add to UNDECLARED_EXEMPT with a reason."
    )


@pytest.mark.parametrize("cls", ENTITY_CLASSES, ids=IDS)
def test_a_subclass_never_silently_drops_an_inherited_policy(cls):
    """Re-declaring a field REPLACES the ancestor's ``FieldInfo`` wholesale.

    So a subclass that re-declares a non-SHARED base field without repeating the
    policy silently opens it up. That is not hypothetical: ``Conversation``
    re-declared ``created_by``, and ``CodexSession``/``CopilotSession`` each
    carried their own ``received`` — all three lost the base's protection, and
    only this check found them.

    A deliberate widening is still possible; it just has to be written down as
    an explicit ``sharing=`` on the subclass field.
    """
    offenders = []
    for name, info in cls.model_fields.items():
        own = sharing_policy(info)
        if own is not Sharing.SHARED:
            continue
        for ancestor in cls.__mro__[1:]:
            fields = getattr(ancestor, "model_fields", None)
            if not fields or name not in fields:
                continue
            inherited = sharing_policy(fields[name])
            if inherited is not Sharing.SHARED:
                offenders.append(f"{name} (ancestor {ancestor.__name__} declares {inherited})")
            break
    assert offenders == [], (
        f"{cls.__name__} re-declares fields and drops the inherited policy: {offenders}"
    )


def test_the_four_boundaries_are_consistent_with_each_other():
    """The accessors are derived from one declaration, so they cannot disagree.

    PRIVATE blocks both directions; HUB_READ is exactly the hub-owned set and is
    withheld from the hub; HUB_WRITE travels but is never accepted.
    """
    from flow_sdk.builtin.flow_message import FlowMessage

    private = {n for n, i in FlowMessage.model_fields.items() if sharing_policy(i) is Sharing.PRIVATE}
    hub_read = {n for n, i in FlowMessage.model_fields.items() if sharing_policy(i) is Sharing.HUB_READ}
    hub_write = {n for n, i in FlowMessage.model_fields.items() if sharing_policy(i) is Sharing.HUB_WRITE}

    assert private <= FlowMessage.fields_not_sent_to_hub()
    assert private <= FlowMessage.fields_not_accepted_from_hub()
    assert private <= FlowMessage.fields_not_in_bundle()
    assert hub_read <= FlowMessage.fields_not_sent_to_hub()
    assert hub_read == FlowMessage.fields_owned_by_hub() & set(FlowMessage.model_fields)
    assert hub_write <= FlowMessage.fields_not_accepted_from_hub()
    assert not (hub_write & FlowMessage.fields_not_sent_to_hub()), "HUB_WRITE must still travel"
    assert not (hub_write & FlowMessage.fields_not_in_bundle()), "HUB_WRITE must ride bundles"


def test_the_known_policies_resolve_as_intended():
    """Spot-check one field per value on the types that motivated each."""
    from flow_sdk.builtin.flow_message import FlowMessage
    from flow_sdk.builtin.task import Task
    from flow_sdk.builtin.user import User

    assert sharing_policy(Task.model_fields["title"]) is Sharing.SHARED
    assert sharing_policy(Task.model_fields["asset_ref"]) is Sharing.PRIVATE
    assert sharing_policy(Task.model_fields["updated_date"]) is Sharing.HUB_READ
    assert sharing_policy(FlowMessage.model_fields["is_read"]) is Sharing.HUB_WRITE
    assert sharing_policy(User.model_fields["hashed_password_"]) is Sharing.PRIVATE
