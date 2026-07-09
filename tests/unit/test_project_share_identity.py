"""Project-as-shared-unit identity + membership wiring.

Covers the load-bearing invariant of making Project a shareable collaboration
unit (members/roles/invites, mirroring Conversation): the sharer's local id is
derived from their filesystem path and must NEVER become the shared hub
identity — an opaque ``cloud_id`` does. Also covers the recipient-side pieces:
a project invitation is a membership invitation (like org/team), and a remote
project mirror must not materialize a local folder.
"""
from flow_sdk.builtin.project import Project


def test_hub_body_publishes_under_cloud_id_not_path_id():
    """``_hub_body`` must POST under ``cloud_id`` and never leak the path id."""
    p = Project(name="demo", fs_storage_mount_path="/tmp/demo_proj_identity")
    path_id = p.id  # uuid5 of the canonical path
    p.cloud_id = "cloud-abc-123"

    body = p._hub_body()

    assert body["id"] == "cloud-abc-123", "hub row must be keyed by cloud_id"
    assert body["id"] != path_id, "the path-derived id must never be the hub identity"
    # ``name`` maps to the hub's ``title`` field.
    assert body["title"] == "demo"
    assert "name" not in body
    # Local-only fields never cross to the hub.
    for leaked in ("fs_storage_mount_path", "members", "cloud_id", "session_code",
                   "include_dirs"):
        assert leaked not in body, f"{leaked} must be stripped from the hub body"


def test_share_mints_cloud_id_and_invites_via_members(monkeypatch):
    """``share(recipients)`` mints an opaque cloud_id and invites each recipient
    at ``/graph/project/<cloud_id>/members`` — never calls a project ``/join``."""
    import inspect

    src = inspect.getsource(Project.share)
    assert "/join" not in src, "projects derive the roster from role edges — no /join"
    assert "project-{self.cloud_id}" in src, "invite target is project-<cloud_id>"
    assert "/members" in src


def test_membership_cls_maps_project():
    """A project invitation rides the membership path (like org/team)."""
    from flow_sdk.app.actions.flow_message_action import _membership_cls
    from flow_sdk.builtin.team import Team

    assert _membership_cls("project") is Project
    # Registry lookup with the back-compat Team fallback for None/empty/unknown.
    assert _membership_cls(None) is Team
    assert _membership_cls("") is Team


def test_remote_mirror_has_no_local_folder():
    """A project shared TO this instance is a cloud mirror — no cwd, no mkdir."""
    rec = Project.model_validate({"id": "cloud-abc-123", "name": "demo", "remote": True})
    assert rec.remote is True
    assert rec.fs_storage_mount_path is None, "a remote mirror must not derive a mount path"


def test_hub_id_property_prefers_cloud_id():
    """Reflected member actions target the hub identity (`entity.hub_id`)."""
    sharer = Project(name="demo", fs_storage_mount_path="/tmp/demo_proj_hubid")
    sharer.cloud_id = "cloud-xyz"
    assert sharer.hub_id == "cloud-xyz", "sharer resolves to cloud_id"

    recipient = Project.model_validate({"id": "cloud-xyz", "remote": True})
    assert recipient.hub_id == "cloud-xyz", "recipient id == cloud_id (no cloud_id field set)"
