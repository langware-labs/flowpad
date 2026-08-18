"""What a shared Project carries onto a receiving machine.

Two different arrivals, one seam. A person accepting an invitation and a box
behind a sandbox handover both end at ``materialize_remote_membership_entity``,
whose ``_MIRRORED_FIELDS`` allow-list is the explicit statement of which fields
cross from the hub. A sandbox mints its Project from just the shared id and a
folder name (``ComputeNode._place_project``), so that allow-list is the only
thing standing between "same project" and "same project in name only".

These pin the language decision at both ends of the trip: it has to leave the
sender, and it has to be let in on arrival — while the path to the checkout on
someone else's disk stays out of both.
"""

from flow_sdk.app.actions.membership_sync import _MIRRORED_FIELDS
from flow_sdk.builtin.project import Project


def test_locale_is_on_the_wire_a_shared_project_puts_up():
    """It has to LEAVE the sender before it can arrive anywhere."""
    project = Project(
        id="33333333-3333-4333-8333-333333333333",
        name="shared-project",
        locale="he",
        fs_storage_mount_path="/Users/author/secret-path",
    )

    body = project._hub_body()

    assert body["locale"] == "he"
    # Per-device UI state stays home, and so does the local path.
    assert "last_mode" not in body
    assert "fs_storage_mount_path" not in body


def test_locale_is_mirrored_from_the_hub_onto_a_receiving_row():
    """The arrival half: the language a project is worked in is a property of
    the WORK, so a recipient opens it in the language its author chose rather
    than falling back to English."""
    assert "locale" in _MIRRORED_FIELDS


def test_the_hub_cannot_redirect_where_a_checkout_lives():
    """``fs_storage_mount_path`` must never be mirrored in.

    The receiver — a box especially — has just placed the checkout at a path
    only it knows. Mirroring the sender's value would point the project at
    someone else's disk layout, and it is the field the sharing docs make an
    explicit privacy promise about.
    """
    assert "fs_storage_mount_path" not in _MIRRORED_FIELDS
    assert "fs_storage_provider" not in _MIRRORED_FIELDS


def test_per_device_ui_state_is_not_mirrored_in():
    """``last_mode`` is about the machine, not the work — it stays home.

    Pinned next to ``locale`` because the two sit side by side on the model and
    look alike; only one of them travels.
    """
    assert "last_mode" not in _MIRRORED_FIELDS
