"""A git dependency added by URL — the flow a vendor's capability layer arrives through.

The customer adds a URL (``Project.add_dependency``), ``flow.json`` records it, the
repo is cloned, linked, indexed, and whatever assets it ships (skills, agents, a
help-desk manifest) become available to the project. "Add a help desk from git" is
not a separate flow — it is this one, and the desk appears because of what was
indexed. ``adopt-helpdesk-from-git`` sits ON TOP of this verb (see
``test_adopt_helpdesk_from_git.py``): it adds through here unchanged and only
reports what showed up, so the properties below hold both flows together.

The properties pinned here are the ones whose failure is silent, and the ones the
N:1 case depends on (one vendor repo, many customer projects):

1. **One Folder, one clone.** The Folder id is ``origin.key()`` — repo coordinates,
   not a path. Two projects depending on the same URL must converge on the same
   entity and the same checkout, or every project pays for its own copy and
   updates have to be applied N times.
2. **Independent per-project links.** The link lives in each project's context,
   NOT as a ``project_id`` stamp on the shared Folder. If it were stamped, the
   second project to add it would steal the first's.
3. **The checkout stays clean** — see ``test_helpdesk_repo_asset.py`` for why.

Uses a real local repo over ``file://`` rather than a mock: cloning is the step
under test, and a stubbed clone would pin nothing. Each test clones into its own
workspace, so a clone from one test is never "reused" by the next.

# do not increase timeout without approval
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from flow_sdk.builtin import project_dependencies
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.folder import Folder
from flow_sdk.builtin.helpdesk import Helpdesk
from flow_sdk.builtin.project import Project
from flow_sdk.fs_store.path_utils import canonical_posix_path
from flow_sdk.schema.type_info import register_all
from tests.unit._project_names import unique_project_name

register_all()

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

MANIFEST = {
    "display_name": "CloudNSite Support",
    "desk_project_id": "4f9f1fd1-39b6-5465-9c20-cb4c59b08318",
    "welcome_message": "Ask us anything about your engagement.",
}


AGENT_JSON = {
    "type": "agent",
    "name": "cloudnsite-support",
    "title": "CloudNSite Support",
    "description": "Grounded answers from CloudNSite's engineering method.",
    "avatar": "./avatar.png",
    "worker_type": "claude",
    "enabled": True,
}
SYSTEM_PROMPT_MD = "You are the CloudNSite support agent.\n"


def _make_vendor_repo(root: Path) -> Path:
    """A vendor capability repo: a help-desk manifest, a skill, and an agent.

    The agent is what the customer actually LAUNCHES, so it is the asset most
    at risk from a stray write — see the save-after-add regression below.
    """
    desk = root / "agentic-assets" / "helpdesk" / "cloudnsite"
    desk.mkdir(parents=True)
    (desk / "helpdesk.json").write_text(json.dumps(MANIFEST), encoding="utf-8")

    agent = root / "agentic-assets" / "agent" / "cloudnsite-support"
    agent.mkdir(parents=True)
    (agent / "agent.json").write_text(json.dumps(AGENT_JSON, indent=2) + "\n", encoding="utf-8")
    (agent / "system_prompt.md").write_text(SYSTEM_PROMPT_MD, encoding="utf-8")

    skill = root / ".claude" / "skills" / "triage-ticket"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text(
        "---\nname: triage-ticket\ndescription: Classify a support ticket\n---\n# triage\n",
        encoding="utf-8",
    )
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=root, check=True, timeout=20)
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
    project = Project(name=unique_project_name(name), fs_storage_mount_path=str(work))
    await project.save()
    return project


def _declared(project: Project) -> dict:
    path = Path(project.fs_storage_mount_path) / "flow.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}


def _folder_typeid(project: Project, path: str) -> str:
    return next(i["typeid"] for i in project.context_dir_infos if i["path"] == path)


@pytest.fixture(autouse=True)
def workspace(tmp_path, monkeypatch):
    """Clones land in this test's own workspace."""
    ws = tmp_path / "workspace"
    ws.mkdir()
    monkeypatch.setattr("flow_sdk.fs_store.origin.git_origin._workspace", lambda: ws)
    project_dependencies._DISMISSED.clear()
    return ws


@pytest.fixture
def vendor_repo(tmp_path: Path) -> str:
    """A git source for a real local repo over ``file://`` — clonable without a network.

    Spelled ``git+file://`` on purpose: a bare ``file:`` prefix is flow.json's
    machine-local folder form, so a bare ``file://`` URL would be linked in place
    rather than cloned. An https/ssh URL needs no prefix (``add_dependency`` adds it)."""
    root = tmp_path / "vendor"
    root.mkdir()
    _make_vendor_repo(root)
    return f"git+file://{root}"


async def test_adding_a_url_clones_links_and_discovers_the_desk(tmp_path: Path, vendor_repo: str, workspace: Path) -> None:
    """The whole flow in one call: URL in, dependency + desk out.

    Nothing declared the desk — it exists because the clone was indexed and the
    repo ships the manifest. That is what makes the desk travel with the assets
    instead of being separately configured.
    """
    project = await _project(tmp_path, "customer-a")
    state = await project.add_dependency(vendor_repo)

    assert state.state == "ready", state
    assert _declared(project) == {"dependencies": {"vendor": vendor_repo}}, (
        "a URL is declared as a git source, named after the repo"
    )
    cloned = Path(state.local_path)
    assert cloned.parent == workspace, "a missing repo is cloned into the workspace"
    assert (cloned / "agentic-assets" / "helpdesk" / "cloudnsite" / "helpdesk.json").is_file()
    assert state.local_path in project.include_dirs

    # Select by PATH, not display name: ``display_name`` is repo-controlled,
    # never an identity.
    desks = [d for d in await Helpdesk.get_all() if d.asset_ref and Path(d.asset_ref).is_relative_to(cloned)]
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


async def test_adding_leaves_the_vendors_checkout_pullable(tmp_path: Path, vendor_repo: str) -> None:
    """THE regression. A dirtied checkout cannot ``git pull``.

    Indexing normally commits the id it mints back into the source — markdown
    gets a ``flowpad:capsule`` block appended. In a vendor repo that dirties
    every tracked file and the next pull aborts on "local changes would be
    overwritten", which silently ends the one property the whole design rests
    on: that a vendor-side improvement reaches every live engagement.

    ``test_helpdesk_repo_asset.py`` pins this for ``_index_additional_dir``
    directly. This pins it for the path a USER actually takes.
    """
    project = await _project(tmp_path, "customer-a")
    state = await project.add_dependency(vendor_repo)
    assert state.state == "ready", state

    tracked = _tracked_changes(Path(state.local_path))
    assert tracked == [], f"adding a repo must leave it pullable; these tracked files were modified: {tracked}"


async def test_a_borrowed_checkout_is_known_to_be_unwritable(tmp_path: Path, vendor_repo: str) -> None:
    """The rule the ADD path cannot express on its own.

    A Project can own a vendor checkout without ever having added it: the
    workspace walk mints a Project for any directory in the workspace, and a
    dependency clone lands right beside the user's own projects. That walk
    indexes writably and has no call-site flag to inherit, so it stamps identity
    capsules into the vendor's tracked files and breaks their next pull.

    Passing ``read_only`` at each call site could not fix that (there is no call
    site — the walk found the directory by itself). The Folder row is what knows
    the bytes came from elsewhere, so the rule is derived from it.
    """
    project = await _project(tmp_path, "customer-a")
    state = await project.add_dependency(vendor_repo)
    assert state.state == "ready", state
    checkout = canonical_posix_path(state.local_path)

    borrowed = await Folder.borrowed_checkout_paths()
    assert checkout in borrowed, (
        "a checkout materialized from a transportable origin must be reported "
        "as borrowed, or the project walk will write into it"
    )

    # A directory the user actually owns must NOT be reported — flagging every
    # folder read-only would stop the user's own assets from ever minting ids.
    own = tmp_path / "my-own-notes"
    own.mkdir()
    assert (await project.add_dependency(str(own))).state == "ready"
    assert canonical_posix_path(str(own)) not in await Folder.borrowed_checkout_paths()


async def test_saving_a_vendor_agent_does_not_dirty_the_checkout(tmp_path: Path, vendor_repo: str) -> None:
    """The regression the INDEX-time flag cannot reach.

    ``read_only`` is a construction-time flag on ``FSRef`` and is never
    serialized — ``meta_dict`` persists only the path — so every reload rebuilds
    the ref writable. For an ``owns_main_ref`` type that is enough to lose the
    guard entirely: ``Agent`` re-renders ``agent.json`` on EVERY save, so one
    ``save()`` after the add (an Enabled toggle in the profile editor is enough)
    rewrites a tracked file in the vendor's checkout and their next ``git pull``
    aborts on "local changes would be overwritten".
    """
    project = await _project(tmp_path, "customer-a")
    state = await project.add_dependency(vendor_repo)
    assert state.state == "ready", state
    checkout = Path(state.local_path)
    agent_json = checkout / "agentic-assets" / "agent" / "cloudnsite-support" / "agent.json"

    agents = [a for a in await Agent.get_all() if a.asset_ref == canonical_posix_path(str(agent_json.parent))]
    assert agents, "indexing the clone should have discovered the vendor's agent"
    await agents[0].save()

    tracked = _tracked_changes(checkout)
    assert tracked == [], (
        f"saving a vendor-supplied agent must leave the checkout pullable; "
        f"these tracked files were modified: {tracked}"
    )


async def test_two_projects_share_one_folder_with_independent_links(tmp_path: Path, vendor_repo: str) -> None:
    """The N:1 case — one vendor repo, many customer projects.

    Folder identity is ``origin.key()`` (repo coordinates), so both projects
    converge on ONE entity and ONE checkout. The link is per-project because it
    lives in each project's context, not as a ``project_id`` stamp on the shared
    Folder — a stamp would mean the second add silently reassigns the first.
    """
    a = await _project(tmp_path, "customer-a")
    b = await _project(tmp_path, "customer-b")

    sa = await a.add_dependency(vendor_repo)
    sb = await b.add_dependency(vendor_repo)

    assert sa.local_path == sb.local_path, "one repo → one checkout, not two"
    folder_tid = _folder_typeid(a, sa.local_path)
    assert folder_tid == _folder_typeid(b, sb.local_path), "one repo → one Folder"

    folder = await Folder.get_by_id(folder_tid.removeprefix("folder-"))
    assert folder is not None
    assert not getattr(folder, "project_id", None), (
        "a shared Folder must not be stamped with one project's id — the link "
        "belongs in each project's context"
    )

    await a.remove_dependency(sa.name)
    a_after = await Project.get_by_id(a.id)
    b_after = await Project.get_by_id(b.id)
    assert sa.local_path not in a_after.include_dirs
    assert sb.local_path in b_after.include_dirs, "removing it from one project must not remove it from the other"
    assert Path(sb.local_path).is_dir(), "the shared checkout must survive a removal"


async def test_re_adding_is_idempotent(tmp_path: Path, vendor_repo: str, workspace: Path) -> None:
    """Adding twice is a no-op, not a duplicate declaration, link or clone —
    the demo re-opens a project repeatedly."""
    project = await _project(tmp_path, "customer-a")
    first = await project.add_dependency(vendor_repo)
    second = await project.add_dependency(vendor_repo)

    assert (first.name, first.local_path) == (second.name, second.local_path)
    assert list(_declared(project)["dependencies"]) == [first.name]
    assert project.include_dirs.count(first.local_path) == 1
    assert [p.name for p in workspace.iterdir()] == [Path(first.local_path).name], "cloned once"


async def test_a_bad_url_is_unreachable_without_linking_anything(tmp_path: Path) -> None:
    """A clone failure must leave no half-linked folder — otherwise the project
    carries an include_dir pointing at nothing. The declaration stays (it is the
    user's intent) and is reported as a warning they can act on."""
    project = await _project(tmp_path, "customer-a")
    missing = tmp_path / "does-not-exist"
    state = await project.add_dependency(f"git+file://{missing}")

    assert state.state == "unreachable"
    assert "could not clone" in (state.reason or "")
    refreshed = await Project.get_by_id(project.id)
    assert refreshed.include_dirs == []
    assert [w.name for w in await refreshed.dependency_warnings()] == [state.name]
