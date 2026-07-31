"""``add-context-dir-from-git`` — attach a repo by URL, in one call.

This is the flow a vendor's capability layer arrives through: the customer
attaches a URL, the repo is cloned, indexed, and whatever assets it ships
(skills, agents, a help-desk manifest) become available to the project. "Add a
help desk from git" is not a separate flow — it is this one, and the desk
appears because of what was indexed.

The properties pinned here are the ones whose failure is silent, and the ones
the N:1 case depends on (one vendor repo, many customer projects):

1. **One Folder, one clone.** The Folder id is ``origin.key()`` — repo
   coordinates, not a path. Two projects attaching the same URL must converge
   on the same entity and the same checkout, or every project pays for its own
   copy and updates have to be applied N times.
2. **Independent per-project adoption.** The link lives in each project's
   context bucket, NOT as a ``project_id`` stamp on the shared Folder. If it
   were stamped, the second project to attach would steal the first's.
3. **It composes rather than forks.** The result must be indistinguishable from
   ``add-context-dir`` on an already-cloned path, so the two flows stay
   exchangeable.
4. **The checkout stays clean** — see ``test_helpdesk_repo_asset.py`` for why.

Uses a real local repo over ``file://`` rather than a mock: cloning is the
step under test, and a stubbed clone would pin nothing.

# do not increase timeout without approval
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from flow_sdk.builtin.folder import Folder
from flow_sdk.builtin.helpdesk import Helpdesk
from flow_sdk.builtin.project import Project
from flow_sdk.schema.type_info import register_all

register_all()

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

MANIFEST = {
    "display_name": "CloudNSite Support",
    "desk_project_id": "4f9f1fd1-39b6-5465-9c20-cb4c59b08318",
    "welcome_message": "Ask us anything about your engagement.",
}


def _make_vendor_repo(root: Path) -> Path:
    """A vendor capability repo: a help-desk manifest plus a skill."""
    desk = root / "agentic-assets" / "helpdesk" / "cloudnsite"
    desk.mkdir(parents=True)
    (desk / "helpdesk.json").write_text(json.dumps(MANIFEST), encoding="utf-8")

    skill = root / ".claude" / "skills" / "triage-ticket"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text(
        "---\nname: triage-ticket\ndescription: Classify a support ticket\n---\n# triage\n",
        encoding="utf-8",
    )
    subprocess.run(["git", "init", "-q"], cwd=root, check=True, timeout=20)
    subprocess.run(["git", "add", "-A"], cwd=root, check=True, timeout=20)
    subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "seed"],
        cwd=root, check=True, capture_output=True, timeout=20,
    )
    return root


async def _project(tmp_path: Path, name: str) -> Project:
    work = tmp_path / name
    work.mkdir()
    project = Project(name=name, fs_storage_mount_path=str(work))
    await project.save()
    return project


@pytest.fixture
def vendor_repo(tmp_path: Path) -> str:
    """A ``file://`` URL for a real local repo — clonable without a network."""
    root = tmp_path / "vendor"
    root.mkdir()
    _make_vendor_repo(root)
    return f"file://{root}"


@pytest.mark.asyncio
async def test_attaching_a_url_clones_links_and_discovers_the_desk(
    tmp_path: Path, vendor_repo: str
) -> None:
    """The whole flow in one call: URL in, context folder + desk out.

    Nothing declared the desk — it exists because the clone was indexed and the
    repo ships the manifest. That is what makes the desk travel with the assets
    instead of being separately configured.
    """
    project = await _project(tmp_path, "customer-a")
    response = await project.add_context_dir_from_git(vendor_repo, scope="private")

    assert response.status == "SUCCESS", response
    data = response.data
    cloned = Path(data["path"])
    assert cloned.is_dir(), "the repo should be on disk after attach"
    assert (cloned / "agentic-assets" / "helpdesk" / "cloudnsite" / "helpdesk.json").is_file()

    # Linked as an ordinary context folder — the same shape add-context-dir
    # produces, so the two flows stay exchangeable.
    assert data["path"] in project.include_dirs

    # Select by PATH, not display name: the test workspace is shared across
    # runs and fixtures, so several clones can carry the same brand — and
    # ``display_name`` is repo-controlled anyway, never an identity.
    desks = [
        d for d in await Helpdesk.get_all()
        if d.asset_ref and Path(d.asset_ref).is_relative_to(cloned)
    ]
    assert desks, "indexing the clone should have discovered the portal"
    desk = desks[0]
    assert desk.display_name == MANIFEST["display_name"]

    # Read THROUGH to the manifest — a denormalized copy would go stale on pull.
    assert desk.desk_project_id == MANIFEST["desk_project_id"]
    assert desk.welcome_message == MANIFEST["welcome_message"]
    assert Path(desk.asset_ref).is_dir(), (
        "asset_ref must point at the portal folder; an empty ref means the "
        "Helpdesk class was not registered and from_record fell back to Entity"
    )


@pytest.mark.asyncio
async def test_attaching_leaves_the_vendors_checkout_pullable(
    tmp_path: Path, vendor_repo: str
) -> None:
    """THE regression. A dirtied checkout cannot ``git pull``.

    Indexing normally commits the id it mints back into the source — markdown
    gets a ``flowpad:capsule`` block appended. In a vendor repo that dirties
    every tracked file and the next pull aborts on "local changes would be
    overwritten", which silently ends the one property the whole design rests
    on: that a vendor-side improvement reaches every live engagement.

    ``test_helpdesk_repo_asset.py`` pins this for ``_index_additional_dir``
    directly. This pins it for the path a USER actually takes — which went
    through a SECOND, un-flagged scan inside ``add_context_dir`` and dirtied
    the checkout despite the helper being called correctly.
    """
    project = await _project(tmp_path, "customer-a")
    response = await project.add_context_dir_from_git(vendor_repo, scope="private")
    assert response.status == "SUCCESS", response

    checkout = Path(response.data["path"])
    tracked = [
        line
        for line in subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=checkout, capture_output=True, text=True, timeout=20,
        ).stdout.splitlines()
        if not line.startswith("??")  # untracked: the test-only shadow store
    ]
    assert tracked == [], (
        f"attaching a repo must leave it pullable; these tracked files were "
        f"modified: {tracked}"
    )


@pytest.mark.asyncio
async def test_two_projects_share_one_folder_with_independent_links(
    tmp_path: Path, vendor_repo: str
) -> None:
    """The N:1 case — one vendor repo, many customer projects.

    Folder identity is ``origin.key()`` (repo coordinates), so both projects
    converge on ONE entity and ONE checkout. Adoption is per-project because it
    lives in the context bucket, not as a ``project_id`` stamp on the shared
    Folder — a stamp would mean the second attach silently reassigns the first.
    """
    a = await _project(tmp_path, "customer-a")
    b = await _project(tmp_path, "customer-b")

    ra = await a.add_context_dir_from_git(vendor_repo, scope="private")
    rb = await b.add_context_dir_from_git(vendor_repo, scope="private")

    assert ra.data["folder_id"] == rb.data["folder_id"], "one repo → one Folder"
    assert ra.data["path"] == rb.data["path"], "one repo → one checkout, not two"

    folder = await Folder.get_by_id(ra.data["folder_id"])
    assert folder is not None
    assert not getattr(folder, "project_id", None), (
        "a shared Folder must not be stamped with one project's id — adoption "
        "belongs in each project's context bucket"
    )

    # Both see it, and detaching one leaves the other intact.
    assert ra.data["path"] in a.include_dirs
    assert rb.data["path"] in b.include_dirs

    await a.remove_context_dir(ra.data["path"])
    a_after = await Project.get_by_id(a.id)
    b_after = await Project.get_by_id(b.id)
    assert ra.data["path"] not in a_after.include_dirs
    assert rb.data["path"] in b_after.include_dirs, (
        "detaching one project must not detach the other"
    )
    assert Path(rb.data["path"]).is_dir(), "the shared checkout must survive a detach"


@pytest.mark.asyncio
async def test_reattaching_is_idempotent(tmp_path: Path, vendor_repo: str) -> None:
    """Attaching twice is a no-op, not a duplicate link or a second clone —
    the demo re-opens a project repeatedly."""
    project = await _project(tmp_path, "customer-a")
    first = await project.add_context_dir_from_git(vendor_repo, scope="private")
    second = await project.add_context_dir_from_git(vendor_repo, scope="private")

    assert first.data["folder_id"] == second.data["folder_id"]
    assert project.include_dirs.count(first.data["path"]) == 1


@pytest.mark.asyncio
async def test_a_bad_url_fails_without_linking_anything(tmp_path: Path) -> None:
    """A clone failure must leave no half-attached folder — otherwise the
    project carries an include_dir pointing at nothing."""
    project = await _project(tmp_path, "customer-a")
    missing = tmp_path / "does-not-exist"
    response = await project.add_context_dir_from_git(f"file://{missing}", scope="private")

    assert response.status != "SUCCESS"
    refreshed = await Project.get_by_id(project.id)
    assert not any(str(missing) in d for d in refreshed.include_dirs)
