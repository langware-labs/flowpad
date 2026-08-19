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

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.folder import Folder
from flow_sdk.builtin.git_origin import GitOrigin
from flow_sdk.builtin.helpdesk import Helpdesk
from flow_sdk.builtin.project import Project
from flow_sdk.fs_store.path_utils import canonical_posix_path
from flow_sdk.schema.type_info import register_all

register_all()

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

MANIFEST = {
    "display_name": "CloudNSite Support",
    "desk_project_id": "4f9f1fd1-39b6-5465-9c20-cb4c59b08318",
    "welcome_message": "Ask us anything about your engagement.",
}


AGENT_MD = """---
name: cloudnsite-support
title: CloudNSite Support
description: Grounded answers from CloudNSite's engineering method.
avatar: ./avatar.png
worker_type: claude
enabled: true
---

You are the CloudNSite support agent.
"""


def _make_vendor_repo(root: Path) -> Path:
    """A vendor capability repo: a help-desk manifest, a skill, and an agent.

    The agent is what the customer actually LAUNCHES, so it is the asset most
    at risk from a stray write — see the save-after-attach regression below.
    """
    desk = root / "agentic-assets" / "helpdesk" / "cloudnsite"
    desk.mkdir(parents=True)
    (desk / "helpdesk.json").write_text(json.dumps(MANIFEST), encoding="utf-8")

    agent = root / "agentic-assets" / "agent" / "cloudnsite-support"
    agent.mkdir(parents=True)
    (agent / "agent.md").write_text(AGENT_MD, encoding="utf-8")

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


def _tracked_changes(repo: Path) -> list[str]:
    """Porcelain lines for TRACKED files only.

    Untracked entries are ignored on purpose: the harness points
    ``FS_RECORD_PATH`` at ``tmp_path/records``, so the shadow store lands inside
    the fixture. What must not happen is a write to a file the repo TRACKS —
    that is what breaks ``git pull``.
    """
    return [
        line
        for line in subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=repo, capture_output=True, text=True, timeout=20,
        ).stdout.splitlines()
        if not line.startswith("??")
    ]


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
    tracked = _tracked_changes(checkout)
    assert tracked == [], (
        f"attaching a repo must leave it pullable; these tracked files were "
        f"modified: {tracked}"
    )


@pytest.mark.asyncio
async def test_a_borrowed_checkout_is_known_to_be_unwritable(
    tmp_path: Path, vendor_repo: str
) -> None:
    """The rule the ATTACH path cannot express on its own.

    A Project can own a vendor checkout without ever having attached it: the
    workspace walk mints a Project for any directory in the workspace, and a
    context-folder clone lands right beside the user's own projects. That walk
    indexes writably and has no call-site flag to inherit, so it stamps
    identity capsules into the vendor's tracked files and breaks their next
    pull — the same regression as before, reached a third way.

    Passing ``read_only`` at each call site could not fix that (there is no
    call site — the walk found the directory by itself). The Folder row is what
    knows the bytes came from elsewhere, so the rule is derived from it.
    """
    project = await _project(tmp_path, "customer-a")
    response = await project.add_context_dir_from_git(vendor_repo, scope="private")
    assert response.status == "SUCCESS", response
    checkout = canonical_posix_path(response.data["path"])

    borrowed = await Folder.borrowed_checkout_paths()
    assert checkout in borrowed, (
        "a checkout materialized from a transportable origin must be reported "
        "as borrowed, or the project walk will write into it"
    )

    # A directory the user actually owns must NOT be reported — flagging every
    # folder read-only would stop the user's own assets from ever minting ids.
    own = tmp_path / "my-own-notes"
    own.mkdir()
    await project.add_context_dir(str(own), scope="private")
    assert canonical_posix_path(str(own)) not in await Folder.borrowed_checkout_paths()


@pytest.mark.asyncio
async def test_saving_a_vendor_agent_does_not_dirty_the_checkout(
    tmp_path: Path, vendor_repo: str
) -> None:
    """The regression the INDEX-time flag cannot reach.

    ``read_only`` is a construction-time flag on ``FSRef`` and is never
    serialized — ``meta_dict`` persists only the path — so every reload rebuilds
    the ref writable. For an ``owns_main_ref`` type that is enough to lose the
    guard entirely: ``Agent`` re-renders ``agent.md`` on EVERY save, so one
    ``save()`` after the attach (an Enabled toggle in the profile editor is
    enough) rewrites a tracked file in the vendor's checkout and their next
    ``git pull`` aborts on "local changes would be overwritten".

    The attach path was already clean; this pins the step AFTER it.
    """
    project = await _project(tmp_path, "customer-a")
    response = await project.add_context_dir_from_git(vendor_repo, scope="private")
    assert response.status == "SUCCESS", response
    checkout = Path(response.data["path"])
    agent_md = checkout / "agentic-assets" / "agent" / "cloudnsite-support" / "agent.md"

    agents = [a for a in await Agent.get_all() if a.asset_ref == canonical_posix_path(str(agent_md))]
    assert agents, "indexing the clone should have discovered the vendor's agent"
    await agents[0].save()

    tracked = _tracked_changes(checkout)
    assert tracked == [], (
        f"saving a vendor-supplied agent must leave the checkout pullable; "
        f"these tracked files were modified: {tracked}"
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


@pytest.mark.asyncio
async def test_existing_checkout_for_another_branch_fails_before_materializing(
    tmp_path: Path,
) -> None:
    project = await _project(tmp_path, "customer-branch-conflict")
    repo_name = f"support-{tmp_path.name}"
    existing_origin = GitOrigin.from_url(
        f"https://github.com/acme/{repo_name}", branch="main", rel_path="."
    )
    assert existing_origin is not None
    await Folder.mint_for_origin(existing_origin)

    response = await project.add_context_dir_from_git(
        f"git@github.com:acme/{repo_name}.git",
        branch="release",
        scope="shared",
    )

    assert response.status == "FAIL"
    assert response.status_code == 409
    assert "main" in response.message
    assert "release" in response.message
    assert project.include_dirs == []


@pytest.mark.asyncio
async def test_reattaching_in_another_scope_moves_one_link(
    tmp_path: Path, vendor_repo: str
) -> None:
    project = await _project(tmp_path, "customer-scope-move")

    first = await project.add_context_dir_from_git(vendor_repo, scope="private")
    moved = await project.add_context_dir_from_git(vendor_repo, scope="shared")
    repeated = await project.add_context_dir_from_git(vendor_repo, scope="shared")

    folder_typeid = (await Folder.get_by_id(first.data["folder_id"])).typeid
    assert moved.data["scope_changed"] is True
    assert moved.data["already_linked"] is False
    assert repeated.data["scope_changed"] is False
    assert repeated.data["already_linked"] is True
    assert str(folder_typeid) not in {
        str(tid) for tid in project.context_of_type("folder", bucket="private")
    }
    assert str(folder_typeid) in {
        str(tid) for tid in project.context_of_type("folder", bucket="shared")
    }
    assert project.include_dirs.count(first.data["path"]) == 1

    moved_back = await project.add_context_dir_from_git(vendor_repo, scope="private")
    assert moved_back.data["scope_changed"] is True
    assert str(folder_typeid) in {
        str(tid) for tid in project.context_of_type("folder", bucket="private")
    }
    assert str(folder_typeid) not in {
        str(tid) for tid in project.context_of_type("folder", bucket="shared")
    }


@pytest.mark.asyncio
async def test_an_unpinned_attach_still_pins_the_remote_default_branch(
    tmp_path: Path, vendor_repo: str
) -> None:
    """An unpinned origin is not merely "freezes at what it first cloned".

    ``matches_repo`` skips its branch check when the origin names no branch
    (``if require_branch and self.branch``), so ANY checkout of this URL
    anywhere on disk matches — on any branch, at any commit — and
    ``_resolve_git_checkout`` gates its pull on the same condition, so nothing
    corrects it afterwards. The attach then silently adopts a checkout it never
    made, and a desk resolved from it carries whatever queue id that stale copy
    happens to hold.

    Observed live: a months-old clone on an unrelated branch was adopted in
    place of the vendor repo, and its ``desk_project_id: null`` made the
    project fall back to the wrong help desk with nothing reported.

    Resolving the remote default (one ``ls-remote``, no objects) is what makes
    both the match and the pull real, so it is the branch on the Folder — not
    the empty string — that this asserts.
    """
    project = await _project(tmp_path, "customer-a")
    response = await project.add_context_dir_from_git(vendor_repo, scope="private")
    assert response.status == "SUCCESS", response

    folder = await Folder.get_by_id(response.data["folder_id"])
    branch = str(getattr(folder.origin, "branch", "") or "")
    assert branch, "an unpinned attach must resolve and pin the remote default branch"

    expected = subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        cwd=vendor_repo.removeprefix("file://"),
        capture_output=True, text=True, timeout=20,
    ).stdout.strip()
    assert branch == expected
