"""Project identity + share invariants after the uuid4 switch.

Project entity ids are opaque uuid4 (no longer path-derived), so a project is
shared under its own id (the Conversation model) with no separate cloud id. The
path-derived value survives only as a record-match alias (``derive_id_for_path``).
"""
import uuid

from flow_sdk.builtin.project import Project


def test_new_project_id_is_uuid4_not_path_derived():
    """A project with a cwd still gets a random uuid4 entity id, != the alias."""
    p = Project(name="demo", fs_storage_mount_path="/tmp/demo_proj_identity")
    assert uuid.UUID(p.id).version == 4, f"entity id must be v4, got {p.id}"
    alias = Project.derive_id_for_path("/tmp/demo_proj_identity")
    assert uuid.UUID(alias).version == 5, "the record alias stays v5-of-path"
    assert p.id != alias, "the entity id must not equal the path-derived alias"


def test_allocate_id_honors_valid_supplied_id_else_uuid4():
    """allocate_id keeps a caller-supplied valid uuid, else mints uuid4 — never derives."""
    supplied = str(uuid.uuid4())
    assert Project.allocate_id({"id": supplied, "fs_storage_mount_path": "/tmp/x"}) == supplied
    got = Project.allocate_id({"fs_storage_mount_path": "/tmp/x"})
    assert uuid.UUID(got).version == 4
    assert got != Project.derive_id_for_path("/tmp/x"), "must not fall back to the path alias"


def test_hub_body_publishes_under_own_id():
    """_hub_body posts under self.id (no cloud id), maps name->title, strips local fields."""
    p = Project(name="demo", fs_storage_mount_path="/tmp/demo_proj_hub")
    body = p._hub_body()
    assert body["id"] == p.id, "hub row is keyed by the project's own id"
    assert body["title"] == "demo"
    assert "name" not in body
    for leaked in ("fs_storage_mount_path", "members", "session_code", "include_dirs"):
        assert leaked not in body, f"{leaked} must be stripped from the hub body"


def test_cloud_id_and_hub_id_machinery_removed():
    """The dual-id sharing indirection is gone — project.id is the shared identity."""
    p = Project(name="demo", fs_storage_mount_path="/tmp/demo_proj_gone")
    assert not hasattr(p, "cloud_id"), "cloud_id field should be removed"
    assert not hasattr(Project, "hub_id"), "hub_id property should be removed"


def test_share_invites_under_own_id():
    """share(recipients) targets project-<self.id> — no /join, no cloud id."""
    import inspect

    src = inspect.getsource(Project.share)
    assert "/join" not in src, "projects derive the roster from role edges — no /join"
    assert "cloud_id" not in src, "no cloud id"
    assert "project-{self.id}" in src and "/members" in src


def test_membership_cls_maps_project():
    """A project invitation rides the membership path (like org/team)."""
    from flow_sdk.app.actions.flow_message_action import _membership_cls
    from flow_sdk.builtin.team import Team

    assert _membership_cls("project") is Project
    assert _membership_cls(None) is Team
    assert _membership_cls("") is Team


def test_remote_mirror_has_no_local_folder():
    """A project shared TO this instance is a cloud mirror — no cwd, no mkdir."""
    rec = Project.model_validate({"id": str(uuid.uuid4()), "name": "demo", "remote": True})
    assert rec.remote is True
    assert rec.fs_storage_mount_path is None, "a remote mirror must not derive a mount path"
