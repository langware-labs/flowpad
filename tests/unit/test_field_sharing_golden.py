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
# The base hub-push exclude. NOTE the deliberate divergence from the bundle set:
# it strips the DATES but keeps the placement fields (asset_ref/scope/path/cwd/
# installed_root/fs_storage_mount_path/expand) — i.e. local paths are pushed to
# the hub today, which is why the receiver defends with `sanitized.pop("asset_ref")`.
# Closing that is the one intended behaviour change of this work.
BASE_HUB_EXCLUDE = [
    "asset_occurrences", "created_by", "created_date", "duplicate_count", "fetched_at",
    "git_origin", "members", "message_count", "private_context_entities",
    "private_context_entities_", "private_context_entity_data", "project_id", "remote",
    "shared_context_entity_data", "system", "tags", "updated_by", "updated_date",
]
BASE_LOCAL_ONLY = ["asset_occurrences", "asset_ref", "fetched_at", "remote", "system"]
HUB_AUTHORITATIVE = ["updated_date"]


def _case(cls, **kwargs):
    inst = cls(**kwargs)
    return inst, _fill(inst)


def test_the_two_egress_seams_diverge_exactly_here():
    """The drift that motivates the consolidation, pinned as a fact.

    If a change makes these two agree, it is this work's P4 and the diff must be
    reviewed — not absorbed silently.
    """
    from flow_sdk.builtin.folder import Folder

    inst, _ = _case(Folder)
    bundle, hub = set(inst._local_fields()), set(_base_hub_exclude(Folder, inst))
    assert sorted(bundle - hub) == [
        "asset_ref", "cwd", "expand", "fs_storage_mount_path", "installed_root", "path", "scope",
    ], "bundle-private but still pushed to the hub"
    assert sorted(hub - bundle) == ["created_date", "updated_date"], "hub-stripped but kept in bundles"


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
            ["attachment", "body_status", "env_vars", "expand", "fs_storage_provider",
             "git_origin", "kind", "last_active_at", "private_context_entities_",
             "shared_context_entities"],
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

    assert sorted(inst._local_fields()) == sorted(BASE_BUNDLE_EXCLUDE + extra_bundle)
    assert _base_hub_exclude(cls, inst) == BASE_HUB_EXCLUDE
    assert sorted(cls.LOCAL_ONLY_FIELDS) == sorted(local_only)
    assert sorted(cls.HUB_AUTHORITATIVE_FIELDS) == HUB_AUTHORITATIVE
    # Coverage honesty: a new field the filler can't populate must be handled,
    # not silently excluded from every assertion above.
    assert could_not_fill == sorted(unfillable)


def test_flow_message_stale_ignore_is_local_only_plus_the_clocks():
    """The one derivable set — it should fall out of the mechanism, not be listed."""
    from flow_sdk.builtin.flow_message import FlowMessage

    assert set(FlowMessage._STALE_IGNORE_FIELDS) == set(FlowMessage.LOCAL_ONLY_FIELDS) | {
        "updated_date", "updated_by",
    }


def test_folder_hub_body_override_strips_the_local_path():
    """Only visible with `path` populated — `exclude_none` hides it otherwise."""
    from flow_sdk.builtin.folder import Folder

    inst, _ = _case(Folder)
    popped, added = _override_delta(inst)
    assert popped == ["path"]
    assert added == []


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
    assert popped == [
        "context_dir_infos", "fs_storage_mount_path", "host_member_id", "include_dirs",
        "last_mode", "last_session_at", "presence", "secret_origins", "session_code",
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
    assert [f for f in _base_hub_exclude(Task, inst) if f in hub] == []
