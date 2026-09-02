"""``adopt-helpdesk-from-git`` — attach a desk repo AND report what arrived.

The attach itself is ``add-context-dir-from-git`` verbatim (see
``test_add_context_dir_from_git.py``, which pins that a desk needs no special
flow to arrive). What this action adds is the REPORT, and every property below
is about a report that would otherwise be silently wrong:

1. **A desk that does not serve is not reported as success.** Resolution walks
   the project's own root first, then context roots in declaration order, and
   stops at the first desk. Attaching a second desk therefore changes nothing
   about routing — so saying "adopted: CloudNSite" would name a vendor that
   will not receive a single ticket.
2. **"Not a desk" keeps the folder.** The repo is still a perfectly good
   context folder; the clone already happened. Detaching would be a second,
   destructive surprise on top of the first.
3. **A desk naming no usable queue is its own outcome.** It resolves to
   nothing, so tickets fall through to the hub's default desk — a different
   company — and the caller has to be able to say so.
4. **The portal Project must be real.** ``portal_project_id`` is what
   ``helpdesk-ensure`` keys its adopted branch on; without a row it silently
   opens the hub's default desk instead.

Real local repos over ``file://`` rather than mocks: the clone is part of what
is under test, and the resolution being tested reads real indexed entities.

# do not increase timeout without approval
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from flow_sdk.app.helpdesk_resolver import resolve_adopted_helpdesk
from flow_sdk.builtin.project import Project
from flow_sdk.fs_store.path_utils import canonical_posix_path
from flow_sdk.schema.type_info import register_all

register_all()

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

QUEUE_A = "4f9f1fd1-39b6-5465-9c20-cb4c59b08318"
QUEUE_B = "00000000-0000-4000-8000-000000000002"


def _commit(root: Path) -> Path:
    subprocess.run(["git", "init", "-q"], cwd=root, check=True, timeout=20)
    subprocess.run(["git", "add", "-A"], cwd=root, check=True, timeout=20)
    subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "seed"],
        cwd=root, check=True, capture_output=True, timeout=20,
    )
    return root


def _desk_repo(root: Path, *, display_name: str, queue_id: str | None) -> str:
    """A vendor repo shipping one help-desk manifest. Returns its ``file://`` URL."""
    desk = root / "agentic-assets" / "helpdesk" / display_name.lower().replace(" ", "-")
    desk.mkdir(parents=True)
    manifest: dict = {"display_name": display_name, "welcome_message": "Ask us anything."}
    if queue_id is not None:
        manifest["desk_project_id"] = queue_id
    (desk / "helpdesk.json").write_text(json.dumps(manifest), encoding="utf-8")
    (root / "guide.md").write_text("# A guide\n", encoding="utf-8")
    _commit(root)
    return f"file://{root}"


def _plain_repo(root: Path) -> str:
    """A repo with no desk manifest at all."""
    (root / "README.md").write_text("# Just a repo\n", encoding="utf-8")
    _commit(root)
    return f"file://{root}"


def _tracked_changes(repo: Path) -> list[str]:
    """Porcelain lines for TRACKED files only — an untracked shadow store is fine,
    a write to a tracked file is what breaks the desk's next ``git pull``."""
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


def _mkdir(tmp_path: Path, name: str) -> Path:
    root = tmp_path / name
    root.mkdir()
    return root


@pytest.mark.asyncio
async def test_adopting_a_desk_repo_reports_the_desk_and_its_portal(tmp_path: Path):
    """The happy path: the manifest's fields come back, and so does a REAL portal
    Project id — the value ``helpdesk-ensure`` needs to open the vendor's portal
    instead of the hub's default desk."""
    url = _desk_repo(_mkdir(tmp_path, "vendor"), display_name="CloudNSite Support", queue_id=QUEUE_A)
    project = await _project(tmp_path, "customer")

    response = await project.adopt_helpdesk_from_git(url)
    data = response.data

    assert data["outcome"] == "adopted"
    assert data["display_name"] == "CloudNSite Support"
    assert data["desk_project_id"] == QUEUE_A
    assert data["helpdesk_id"]
    assert data["welcome_message"] == "Ask us anything."

    # A real row, not a derived id: look it up.
    portal = await Project.get_by_id(data["portal_project_id"])
    assert portal is not None
    assert canonical_posix_path(portal.fs_storage_mount_path) == data["path"]

    # And the folder really is attached to the customer project.
    refreshed = await Project.get_by_id(str(project.id))
    assert data["path"] in [canonical_posix_path(p) for p in refreshed.include_dirs]


@pytest.mark.asyncio
async def test_a_repo_with_no_manifest_stays_attached(tmp_path: Path):
    """Property 2. The clone already happened and the folder is still useful, so
    "this is not a desk" must not also mean "and I threw it away"."""
    url = _plain_repo(_mkdir(tmp_path, "notadesk"))
    project = await _project(tmp_path, "customer")

    data = (await project.adopt_helpdesk_from_git(url)).data

    assert data["outcome"] == "no_manifest"
    assert data["helpdesk_id"] is None
    assert data["display_name"] is None

    refreshed = await Project.get_by_id(str(project.id))
    assert data["path"] in [canonical_posix_path(p) for p in refreshed.include_dirs], (
        "the folder must remain attached — the caller offers Remove, it is not automatic"
    )


@pytest.mark.asyncio
async def test_a_desk_naming_no_valid_queue_is_its_own_outcome(tmp_path: Path):
    """Property 3. This desk resolves to nothing, so every ticket silently goes to
    the hub's default desk. 'no_manifest' would be a lie and 'adopted' worse."""
    url = _desk_repo(_mkdir(tmp_path, "brokendesk"), display_name="Broken Desk", queue_id="not-a-uuid")
    project = await _project(tmp_path, "customer")

    data = (await project.adopt_helpdesk_from_git(url)).data

    assert data["outcome"] == "invalid_desk_project_id"
    assert data["display_name"] == "Broken Desk"
    assert data["helpdesk_id"], "the desk WAS found — it just names no usable queue"
    assert await resolve_adopted_helpdesk(str(project.id)) is None


@pytest.mark.asyncio
async def test_a_second_desk_is_reported_as_shadowed_not_adopted(tmp_path: Path):
    """Property 1, the dangerous one.

    ``resolve_adopted_helpdesk`` returns the FIRST desk in root order, so the
    second one attached changes nothing about where tickets go. Reporting it as
    adopted would tell a customer their requests now reach vendor B while every
    one of them keeps going to vendor A.
    """
    url_a = _desk_repo(_mkdir(tmp_path, "vendor_a"), display_name="Desk A", queue_id=QUEUE_A)
    url_b = _desk_repo(_mkdir(tmp_path, "vendor_b"), display_name="Desk B", queue_id=QUEUE_B)
    project = await _project(tmp_path, "customer")

    first = (await project.adopt_helpdesk_from_git(url_a)).data
    assert first["outcome"] == "adopted"

    reloaded = await Project.get_by_id(str(project.id))
    second = (await reloaded.adopt_helpdesk_from_git(url_b)).data

    assert second["outcome"] == "shadowed"
    assert second["display_name"] == "Desk B", "the desk we found is still named"
    assert second["shadowed_by"]["desk_project_id"] == QUEUE_A
    assert second["shadowed_by"]["display_name"] == "Desk A"

    serving = await resolve_adopted_helpdesk(str(project.id))
    assert serving is not None and serving.queue_project_id == QUEUE_A, (
        "routing must be unchanged — that is the whole point of the shadowed outcome"
    )


@pytest.mark.asyncio
async def test_re_adopting_the_same_desk_reports_already_adopted(tmp_path: Path):
    """A repeat add is idempotent and must not claim to have done work — the
    dialog says 'Already attached' and goes straight to Open."""
    url = _desk_repo(_mkdir(tmp_path, "vendor"), display_name="CloudNSite Support", queue_id=QUEUE_A)
    project = await _project(tmp_path, "customer")

    first = (await project.adopt_helpdesk_from_git(url)).data
    reloaded = await Project.get_by_id(str(project.id))
    second = (await reloaded.adopt_helpdesk_from_git(url)).data

    assert first["outcome"] == "adopted"
    assert second["outcome"] == "already_adopted"
    assert second["path"] == first["path"], "the same checkout, not a second clone"
    assert second["helpdesk_id"] == first["helpdesk_id"]


@pytest.mark.asyncio
async def test_the_adopted_checkout_stays_pullable(tmp_path: Path):
    """Indexing normally stamps ids back into markdown, which dirties the
    checkout and makes the desk's next ``git pull`` abort. A vendor desk that
    cannot pull stops receiving updates — the whole pitch."""
    vendor = _mkdir(tmp_path, "vendor")
    url = _desk_repo(vendor, display_name="CloudNSite Support", queue_id=QUEUE_A)
    project = await _project(tmp_path, "customer")

    data = (await project.adopt_helpdesk_from_git(url)).data

    assert _tracked_changes(Path(data["path"])) == []
