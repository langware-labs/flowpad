"""``setup-from-bootstrap-git`` — start an engagement from a template repo.

A vendor publishes a template; a customer starts a project from it. The split
this pins is the whole design:

* **The template body becomes the customer's.** History is severed, a fresh
  empty repo is initialized, and the vendor's remote is gone. Their first commit
  is their own. So the template goes stale the moment it is cloned.
* **The declared help desks do not.** They are attached as ordinary context
  folders pointing at the VENDOR's repo, so they keep updating in every live
  engagement long after the template that named them was copied.

Get that backwards and the demo's punchline ("we sharpen the method and every
engagement gets it") quietly stops being true, with nothing failing to show it.

Uses real local repos over ``file://`` — cloning and history-severing are the
steps under test, and a stub would pin neither.

# do not increase timeout without approval
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from flow_sdk.builtin.bootstrap_manifest import BootstrapManifest, read_bootstrap_manifest
from flow_sdk.builtin.project import Project
from flow_sdk.schema.type_info import register_all

register_all()

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

DESK_MANIFEST = {
    "display_name": "CloudNSite Support",
    "desk_project_id": "4f9f1fd1-39b6-5465-9c20-cb4c59b08318",
}


def _commit(root: Path) -> None:
    subprocess.run(["git", "init", "-q"], cwd=root, check=True, timeout=20)
    subprocess.run(["git", "add", "-A"], cwd=root, check=True, timeout=20)
    subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "seed"],
        cwd=root, check=True, capture_output=True, timeout=20,
    )


@pytest.fixture
def helpdesk_repo(tmp_path: Path) -> str:
    """The vendor's capability layer — stays theirs, keeps updating."""
    root = tmp_path / "vendor-helpdesk"
    desk = root / "agentic-assets" / "helpdesk" / "cloudnsite"
    desk.mkdir(parents=True)
    (desk / "helpdesk.json").write_text(json.dumps(DESK_MANIFEST), encoding="utf-8")
    _commit(root)
    return f"file://{root}"


@pytest.fixture
def bootstrap_repo(tmp_path: Path, helpdesk_repo: str) -> str:
    """The engagement template — becomes the customer's on clone."""
    root = tmp_path / "vendor-bootstrap"
    (root / ".flowpad").mkdir(parents=True)
    (root / ".flowpad" / "bootstrap.json").write_text(
        json.dumps({"helpdesks": [helpdesk_repo], "autolaunch_journey": "engagement-setup"}),
        encoding="utf-8",
    )
    (root / "docs").mkdir()
    (root / "docs" / "00-discovery.md").write_text("# Discovery\n", encoding="utf-8")
    _commit(root)
    return f"file://{root}"


async def _project(name: str = "customer-engagement") -> Project:
    project = Project(name=name)
    await project.save()
    return project


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, capture_output=True, text=True, timeout=20
    ).stdout.strip()


# ── the manifest reader ─────────────────────────────────────────────────────


def test_manifest_reads_declared_helpdesks_and_journey(tmp_path: Path) -> None:
    (tmp_path / ".flowpad").mkdir()
    (tmp_path / ".flowpad" / "bootstrap.json").write_text(
        json.dumps({"helpdesks": ["https://x/a", "https://x/b"], "autolaunch_journey": "setup"}),
        encoding="utf-8",
    )
    manifest = read_bootstrap_manifest(tmp_path)
    assert manifest.helpdesks == ("https://x/a", "https://x/b")
    assert manifest.autolaunch_journey == "setup"


@pytest.mark.parametrize(
    "body",
    [None, "", "{not json", "[]", '"a string"', '{"helpdesks": "not-a-list"}', '{"helpdesks": [1, 2]}'],
    ids=["missing", "empty", "invalid", "array", "scalar", "wrong-type", "non-strings"],
)
def test_a_hostile_or_broken_manifest_declares_nothing(tmp_path: Path, body) -> None:
    """This file comes from a third-party repo. It must degrade to "declares
    nothing" rather than fail a project setup that is already half done."""
    if body is not None:
        (tmp_path / ".flowpad").mkdir()
        (tmp_path / ".flowpad" / "bootstrap.json").write_text(body, encoding="utf-8")
    assert read_bootstrap_manifest(tmp_path) == BootstrapManifest()


def test_declared_helpdesks_are_bounded_and_deduped(tmp_path: Path) -> None:
    """A template declaring hundreds of desks is a mistake or an attack — it
    must not turn setup into an unbounded series of clones."""
    (tmp_path / ".flowpad").mkdir()
    (tmp_path / ".flowpad" / "bootstrap.json").write_text(
        json.dumps({"helpdesks": ["https://x/same"] * 3 + [f"https://x/{i}" for i in range(50)]}),
        encoding="utf-8",
    )
    desks = read_bootstrap_manifest(tmp_path).helpdesks
    assert len(desks) == len(set(desks)), "repeated URLs must not prompt repeatedly"
    assert len(desks) <= 8


# ── the flow ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_template_files_become_the_customers_with_no_vendor_history(
    bootstrap_repo: str,
) -> None:
    """THE property. The customer gets files, not a fork.

    If the vendor's history or remote survived, the customer's first push would
    carry the vendor's commits — and 'connect your own git' would mean
    'inherit ours'.
    """
    project = await _project()
    response = await project.setup_from_bootstrap_git(bootstrap_repo)
    assert response.status == "SUCCESS", response

    root = Path(response.data["path"])
    assert (root / "docs" / "00-discovery.md").is_file(), "the template body should be here"

    assert _git(root, "log", "--oneline") == "", "the vendor's history must not survive"
    assert _git(root, "remote") == "", "the vendor's remote must not survive"
    assert (root / ".git").is_dir(), (
        "a fresh empty repo should be initialized so the customer can commit"
    )


@pytest.mark.asyncio
async def test_declared_helpdesk_is_attached_as_a_link_not_a_copy(
    bootstrap_repo: str, helpdesk_repo: str
) -> None:
    """The other half: what must NOT become the customer's.

    The desk is attached as a context folder pointing at the vendor's repo, so
    it keeps updating. A copy inside the project would freeze at clone time.
    """
    project = await _project()
    response = await project.setup_from_bootstrap_git(bootstrap_repo)
    assert response.status == "SUCCESS", response
    data = response.data

    assert not data["helpdesks_failed"], data["helpdesks_failed"]
    assert len(data["helpdesks"]) == 1
    desk_path = Path(data["helpdesks"][0]["path"])

    assert desk_path.is_dir()
    assert (desk_path / "agentic-assets" / "helpdesk" / "cloudnsite" / "helpdesk.json").is_file()
    assert str(desk_path) in project.include_dirs, "must reach workers as a context dir"

    # Outside the project tree, and still a git checkout — that is what lets a
    # vendor-side change reach this engagement on a later pull.
    project_root = Path(data["path"]).resolve()
    assert project_root not in desk_path.resolve().parents, (
        "a desk copied INTO the project would freeze at clone time"
    )
    assert (desk_path / ".git").exists(), "the desk must stay linked to the vendor's repo"

    assert data["autolaunch_journey"] == "engagement-setup"


@pytest.mark.asyncio
async def test_an_unreachable_desk_does_not_undo_a_finished_setup(tmp_path: Path) -> None:
    """A vendor's desk being down must not cost the customer their project —
    the files are already on disk and the failure is reportable."""
    root = tmp_path / "bootstrap-bad-desk"
    (root / ".flowpad").mkdir(parents=True)
    (root / ".flowpad" / "bootstrap.json").write_text(
        json.dumps({"helpdesks": [f"file://{tmp_path / 'nope'}"]}), encoding="utf-8"
    )
    (root / "README.md").write_text("# Engagement\n", encoding="utf-8")
    _commit(root)

    project = await _project()
    response = await project.setup_from_bootstrap_git(f"file://{root}")

    assert response.status == "SUCCESS", "the project itself succeeded"
    assert (Path(response.data["path"]) / "README.md").is_file()
    assert response.data["helpdesks"] == []
    assert len(response.data["helpdesks_failed"]) == 1, "the failure must be reported, not swallowed"


@pytest.mark.asyncio
async def test_a_template_with_no_manifest_is_an_ordinary_template(tmp_path: Path) -> None:
    """Declaring a desk is optional — a plain repo must still work as a
    template, or every template author is forced into the mechanism."""
    root = tmp_path / "plain-template"
    root.mkdir()
    (root / "README.md").write_text("# Plain\n", encoding="utf-8")
    _commit(root)

    project = await _project()
    response = await project.setup_from_bootstrap_git(f"file://{root}")

    assert response.status == "SUCCESS", response
    assert (Path(response.data["path"]) / "README.md").is_file()
    assert response.data["helpdesks"] == []
    assert response.data["autolaunch_journey"] is None


@pytest.mark.asyncio
async def test_the_checkout_is_named_after_the_engagement_not_the_template(
    bootstrap_repo: str,
) -> None:
    """A customer whose working folder is called ``vendor-bootstrap`` has been
    handed the vendor's name for their own work."""
    project = await _project("northwind-support")
    response = await project.setup_from_bootstrap_git(bootstrap_repo)

    leaf = Path(response.data["path"]).name
    assert leaf.startswith("northwind-support"), leaf
    assert "bootstrap" not in leaf, "the template's name must not become the customer's"


@pytest.mark.asyncio
async def test_two_engagements_from_one_template_are_independent(bootstrap_repo: str) -> None:
    """Two customers, two working copies. Reusing a checkout is right for
    ``setup_from_git`` (same project, same repo) and wrong here."""
    a = await _project("engagement-a")
    b = await _project("engagement-b")
    ra = await a.setup_from_bootstrap_git(bootstrap_repo)
    rb = await b.setup_from_bootstrap_git(bootstrap_repo)

    assert ra.data["path"] != rb.data["path"], "two engagements must not share a working copy"

    # ...but the DESK is shared: one vendor repo, one checkout, N engagements.
    assert ra.data["helpdesks"][0]["path"] == rb.data["helpdesks"][0]["path"]


@pytest.mark.asyncio
async def test_a_bad_template_url_fails_without_binding_the_project(tmp_path: Path) -> None:
    """A failed clone must not repoint the project at the empty target dir.

    (``Project(name=…)`` derives a mount path at construction, so what is
    checked is that setup did not REBIND it to the failed checkout.)
    """
    project = await _project()
    before = project.fs_storage_mount_path
    response = await project.setup_from_bootstrap_git(f"file://{tmp_path / 'does-not-exist'}")

    assert response.status != "SUCCESS"
    assert project.fs_storage_mount_path == before, (
        "a failed setup must leave the project pointing where it did"
    )
    assert "does-not-exist" not in (project.fs_storage_mount_path or "")
