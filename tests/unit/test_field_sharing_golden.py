"""P0 — golden snapshot of every field-sharing boundary, BEFORE the mechanism changes.

"Which fields cross which boundary" is spread across six hand-maintained name
lists (``_BASE_LOCAL_FIELDS``, ``TypeInfo.local_fields``, ``_hub_body``'s exclude
literal, ``LOCAL_ONLY_FIELDS`` + its subclass unions, ``HUB_AUTHORITATIVE_FIELDS``,
``_STALE_IGNORE_FIELDS``) plus two per-type ``_hub_body`` overrides. They are being
consolidated into one per-field ``Sharing`` declaration. This file pins today's
answers so the consolidation is provably content-preserving, and so the one
deliberate behaviour change lands as a reviewable diff.

It closes a real gap: every existing assertion is one-directional ("x not in
body"), so a field that starts travelling — the exact failure mode of a missed
annotation — passes the whole suite today.

WHAT IS PINNED, AND WHY IT IS THE POLICY AND NOT THE PAYLOAD
    The seams are ``model_dump(exclude=<policy>, exclude_none=True)``. We assert
    the POLICY (the exclude set each seam passes, plus what the per-type
    overrides remove on top) rather than the emitted keys. Emitted keys change
    whenever anyone adds an unrelated field — noise; the policy changes only when
    someone changes what crosses a boundary — signal.

WHY THE FIXTURES POPULATE EVERY FIELD
    ``exclude_none=True`` means a None-valued field is absent from the dump for a
    reason that has nothing to do with policy. That hid a real rule from an
    earlier draft of this very file: with a bare ``Folder()``, ``path`` is None,
    so ``Folder._hub_body``'s ``body.pop("path")`` looked like a no-op. Fields are
    therefore filled before any comparison, and ``_UNFILLABLE`` is asserted
    exactly — a new field the filler can't handle fails here rather than silently
    dropping out of coverage.
"""

from __future__ import annotations

import datetime
from typing import Any

import pytest

import flow_sdk.models.entities  # noqa: F401  — registers the entity types
from flow_sdk.core.entity.entity_model import Entity

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

_SENTINEL_DT = datetime.datetime(2020, 1, 1, tzinfo=datetime.timezone.utc)
_SENTINEL_UUID = "11111111-1111-4111-8111-111111111111"


def _fill(inst: Entity) -> list[str]:
    """Give every simply-typed field a non-None value; return what we couldn't.

    Deliberately dumb: it covers the scalar/list/dict shapes that carry sharing
    policy. Anything exotic (nested models, enums, env-var containers) is
    reported rather than guessed at, and the caller asserts that list.
    """
    unfilled: list[str] = []
    for name, f in type(inst).model_fields.items():
        if name in ("id", "type"):
            continue  # identity — always present, never policy-bearing
        ann = str(f.annotation)
        value: Any
        if f.annotation is str or ann in ("typing.Optional[str]", "str | None"):
            # Id-shaped fields are parsed (TypeId) by the API serializer, so they
            # need a real uuid — an arbitrary sentinel raises mid-dump.
            value = _SENTINEL_UUID if name.endswith("_id") else f"_{name}_"
        elif f.annotation is bool:
            value = True
        elif f.annotation is int:
            value = 7
        elif f.annotation is float:
            value = 1.5
        elif "datetime.datetime" in ann:
            value = _SENTINEL_DT
        elif ann in ("typing.List[str]", "list[str]", "typing.Optional[typing.List[str]]"):
            value = ["a"]
        elif ann in ("typing.List[dict]", "list[dict]", "typing.Optional[typing.List[dict]]"):
            value = [{"k": "v"}]
        elif ann.startswith("dict[") or ann.startswith("typing.Dict") or ann.startswith("typing.Optional[dict"):
            value = {"k": "v"}
        else:
            unfilled.append(name)
            continue
        try:
            setattr(inst, name, value)
        except Exception:  # noqa: BLE001 — a validator refused; report, don't guess
            unfilled.append(name)
    return sorted(unfilled)


def _base_hub_exclude(cls: type[Entity], inst: Entity) -> list[str]:
    """The exclude set the BASE ``_hub_body`` passes to ``model_dump``.

    Captured off the call rather than read from the literal, so it keeps working
    once the literal is replaced by the derived set.
    """
    captured: list[set[str]] = []
    original = cls.model_dump

    def spy(self, **kwargs):
        captured.append(set(kwargs.get("exclude") or ()))
        return original(self, **kwargs)

    cls.model_dump = spy  # type: ignore[method-assign]
    try:
        Entity._hub_body(inst)
    finally:
        cls.model_dump = original  # type: ignore[method-assign]
    return sorted(captured[0]) if captured else []


def _override_delta(inst: Entity) -> tuple[list[str], list[str]]:
    """(popped, added) — what a per-type ``_hub_body`` override does on top of the base."""
    base = set(Entity._hub_body(inst))
    final = set(inst._hub_body())
    return sorted(base - final), sorted(final - base)


# ── The base sender-local set, shared by every type ───────────────────────────
BASE_BUNDLE_EXCLUDE = [
    "asset_occurrences", "asset_ref", "created_by", "cwd", "duplicate_count", "expand",
    "fetched_at", "fs_storage_mount_path", "git_origin", "installed_root", "members",
    "message_count", "path", "private_context_entities", "private_context_entities_",
    "private_context_entity_data", "project_id", "remote", "scope",
    "shared_context_entity_data", "system", "tags", "updated_by",
]
# The hub-push exclude as it stood BEFORE the seams were derived: it stripped the
# DATES but kept the placement fields, i.e. local paths were pushed to the hub —
# which is why the receiver defended with `sanitized.pop("asset_ref")`.
BASE_HUB_EXCLUDE = [
    "asset_occurrences", "created_by", "created_date", "duplicate_count", "fetched_at",
    "git_origin", "members", "message_count", "private_context_entities",
    "private_context_entities_", "private_context_entity_data", "project_id", "remote",
    "shared_context_entity_data", "system", "tags", "updated_by", "updated_date",
]
# Now WITHHELD from the hub as well as from bundles — the one intended behaviour
# change of this work. Each is a local path or a local projection the hub has no
# use for; a receiver cannot bind a sender's absolute path.
CONVERGED_TO_PRIVATE = {
    "asset_ref", "scope", "path", "cwd", "installed_root", "fs_storage_mount_path", "expand",
    "my_process_id", "project_root", "project_name",
}
# Fields that carried NO policy at all (bare pydantic `Field`, so they resolved
# to SHARED and travelled) and are now declared PRIVATE. `fs_storage_provider`
# was popped from the hub body by hand in `Project._hub_body` — that pop was the
# policy; `visitor_role` is a per-request auth projection whose declaration even
# said "Use Field not APIField for security".
NEWLY_DECLARED_PRIVATE = {"fs_storage_provider", "visitor_role"}
BASE_LOCAL_ONLY = ["asset_occurrences", "asset_ref", "fetched_at", "remote", "system"]
HUB_AUTHORITATIVE = ["updated_date"]


def _case(cls, **kwargs):
    inst = cls(**kwargs)
    return inst, _fill(inst)


def test_the_two_egress_seams_now_agree():
    """The drift this file was written to pin is CLOSED.

    Before: the bundle seam stripped the placement fields while `_hub_body` still
    pushed them, and `_hub_body` stripped the clocks while bundles kept them —
    two hand-maintained lists that had drifted apart in both directions. Both are
    derived from the same declarations now, so the only remaining difference is
    the one the model states on purpose: `HUB_READ` fields (the clocks) are
    withheld from the hub and ride bundles.
    """
    from flow_sdk.builtin.folder import Folder

    inst, _ = _case(Folder)
    declared = set(Folder.model_fields) | set(Folder.model_computed_fields)
    bundle = set(inst._local_fields()) & declared
    hub = set(_base_hub_exclude(Folder, inst)) & declared

    assert bundle - hub == set(), "a bundle-private field is still pushed to the hub"
    assert sorted(hub - bundle) == ["created_date", "updated_date"], "HUB_READ, by design"


@pytest.mark.parametrize(
    "module, name, kwargs, extra_bundle, local_only, unfillable",
    [
        (
            "flow_sdk.builtin.task", "Task", {"title": "x"},
            # Task is the ONLY type declaring TypeInfo.local_fields.
            ["my_process_id", "project_name", "project_root"],
            BASE_LOCAL_ONLY,
            ["artifacts", "env_vars", "expand", "fs_storage_provider", "git_origin",
             "last_active_at", "private_context_entities_", "shared_context_entities", "ttl"],
        ),
        (
            "flow_sdk.builtin.folder", "Folder", {}, [], BASE_LOCAL_ONLY,
            ["env_vars", "expand", "fs_storage_provider", "git_origin", "last_active_at",
             "origin", "private_context_entities_", "shared_context_entities"],
        ),
        (
            "flow_sdk.builtin.flow_message", "FlowMessage", {"text": "t"}, [],
            # Per-device inbox state: travels outward, but a hub refresh must not reset it.
            ["asset_occurrences", "asset_ref", "body_status", "fetched_at", "is_archived",
             "is_draft", "is_read", "prompt_auto_handled", "received_at", "remote", "system"],
            # `body_status` is an enum the filler leaves None — it is still pinned by
            # the LOCAL_ONLY assertion above, just not by the leak guard.
            # `origin` is a nested CloudOrigin model the filler leaves None —
            # the cloud record this message caches, absent on Flowpad-native ones.
            ["attachment", "body_status", "env_vars", "expand", "fs_storage_provider",
             "git_origin", "kind", "last_active_at", "origin",
             "private_context_entities_", "shared_context_entities"],
        ),
        (
            "flow_sdk.builtin.claude_session", "ClaudeSession", {}, [],
            ["asset_occurrences", "asset_ref", "fetched_at", "received", "remote", "system"],
            ["env_vars", "expand", "fs_storage_provider", "git_origin", "last_active_at",
             "private_context_entities_", "shared_context_entities"],
        ),
        (
            "flow_sdk.builtin.message_attachment", "MessageAttachment", {}, [], BASE_LOCAL_ONLY,
            ["env_vars", "expand", "fs_storage_provider", "last_active_at",
             "private_context_entities_", "shared_context_entities"],
        ),
        (
            "flow_sdk.builtin.conversation", "Conversation", {}, [], BASE_LOCAL_ONLY,
            # `message_count`/`message_ids` are projections; Conversation's setattr
            # guard refuses them, which is itself the policy under test elsewhere.
            ["env_vars", "expand", "fs_storage_provider", "git_origin", "kind",
             "last_active_at", "message_count", "message_ids",
             "private_context_entities_", "shared_context_entities"],
        ),
    ],
)
def test_seam_policy_per_type(module, name, kwargs, extra_bundle, local_only, unfillable):
    import importlib

    cls = getattr(importlib.import_module(module), name)
    inst, could_not_fill = _case(cls, **kwargs)

    # The derived set contains only names the type DECLARES, where the old
    # literal was a global superset. That is behaviour-identical — pydantic
    # ignores `exclude` entries a model doesn't have, which is why the literal
    # could carry `path`/`cwd`/`installed_root` for types that never had them —
    # so assert the difference is exactly the undeclared names, not a loosening.
    literal = set(BASE_BUNDLE_EXCLUDE + extra_bundle) | NEWLY_DECLARED_PRIVATE
    declared = set(cls.model_fields) | set(cls.model_computed_fields)
    assert set(inst._local_fields()) == literal & declared
    assert (literal - set(inst._local_fields())) <= (literal - declared)
    # Derived per type now, so compare against the literal narrowed to what this
    # type declares, plus the fields the convergence newly withholds.
    hub_expected = (set(BASE_HUB_EXCLUDE) | CONVERGED_TO_PRIVATE | NEWLY_DECLARED_PRIVATE) & declared
    assert set(_base_hub_exclude(cls, inst)) == hub_expected
    # Ingress protection is now derived: PRIVATE ∪ HUB_WRITE. It is a superset
    # of the old hand-written LOCAL_ONLY_FIELDS (which listed only the fields
    # someone remembered), so assert containment plus the type's own additions.
    blocked = cls.fields_not_accepted_from_hub()
    assert set(local_only) & declared <= blocked
    assert cls.fields_owned_by_hub() == {"created_date", "updated_date"} & declared
    # Coverage honesty: a new field the filler can't populate must be handled,
    # not silently excluded from every assertion above.
    assert could_not_fill == sorted(unfillable)


def test_flow_message_stale_ignore_is_derived_not_listed():
    """`_STALE_IGNORE_FIELDS` is gone — `is_stale` derives it.

    The per-device state a hub refresh must not reset (`is_read`, `body_status`,
    …) is exactly what a touch-vs-change comparison has to ignore, so the second
    list was always the first list plus the clocks.
    """
    from flow_sdk.builtin.flow_message import FlowMessage

    assert not hasattr(FlowMessage, "_STALE_IGNORE_FIELDS")
    blocked = FlowMessage.fields_not_accepted_from_hub()
    assert {"is_read", "body_status", "is_draft", "prompt_auto_handled"} <= blocked


def test_folder_no_longer_needs_an_override_to_hide_its_local_path():
    """`path` is withheld by its declaration, so the override's pop was deleted.

    The base seam must still withhold it — that is the whole point of moving the
    rule to the field.
    """
    from flow_sdk.builtin.folder import Folder

    inst, _ = _case(Folder)
    assert "path" in Folder.fields_not_sent_to_hub()
    assert "path" not in inst._hub_body()
    popped, added = _override_delta(inst)
    assert popped == [] and added == []


def test_project_hub_body_override_strips_local_project_state():
    """`name` travels VERBATIM — there is deliberately no name→title mapping
    (a project rename fell through that seam; see Project._hub_body)."""
    from flow_sdk.builtin.project import Project

    inst, could_not_fill = _case(Project, name="p")
    popped, added = _override_delta(inst)
    # 12 of the override's 13 pops. `fs_storage_provider` is an enum the filler
    # leaves None, so `exclude_none` removes it before the pop can — the same
    # blind spot that hid Folder's `path`, here made explicit instead of assumed.
    assert "fs_storage_provider" in could_not_fill
    # `fs_storage_mount_path` has dropped off this list: the base seam now
    # withholds it, so the override's pop is a no-op. The override is shrinking
    # toward the remainder that genuinely is not per-field policy.
    assert popped == [
        "context_dir_infos", "host_member_id", "include_dirs", "last_mode",
        "last_session_at", "presence", "secret_origins", "session_code",
        "session_count", "shared_context_origins", "shared_secret_origins",
    ]
    assert added == []
    assert "name" in inst._hub_body(), "the hub hosts a project's name verbatim"


def test_no_policy_field_leaks_into_either_seam():
    """General leak guard, both directions, on a fully-populated instance."""
    from flow_sdk.builtin.task import Task

    inst, _ = _case(Task, title="Ship")
    bundle = inst.to_common_json()
    assert [f for f in inst._local_fields() if f in bundle] == []
    hub = inst._hub_body()
    # `expand` is the one exception, and it is NOT a policy failure: the API
    # serializer re-injects computed/projection outputs AFTER `exclude` has been
    # applied (`to_common_json` avoids this with `skip_api_serializer`). It was
    # in the hub body before this refactor and still is — declaring it PRIVATE
    # changed nothing here. Suppressing it means changing the serializer context
    # for the whole hub body, which is a broader change than this seam.
    leaked = [f for f in _base_hub_exclude(Task, inst) if f in hub]
    assert leaked == ["expand"], f"unexpected leak: {leaked}"
