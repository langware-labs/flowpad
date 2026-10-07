"""``setup-from-bootstrap-git`` — start an engagement from a template repo.

A vendor publishes a template; a customer starts a project from it. The split
this pins is the whole design:

* **The template body becomes the customer's.** History is severed, a fresh
  empty repo is initialized, and the vendor's remote is gone. Their first commit
  is their own. So the template goes stale the moment it is cloned.
* **The template's ``flow.json`` dependencies do not.** They resolve as ordinary
  dependencies pointing at the VENDOR's repo, so a help desk the template names
  keeps updating in every live engagement long after the template was copied.

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

from flow_sdk.assets import flow_json
from flow_sdk.builtin import project_dependencies
from flow_sdk.builtin.project import Project
from flow_sdk.schema.type_info import register_all
from tests.unit._project_names import unique_project_name

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


@pytest.fixture(autouse=True)
def workspace(tmp_path, monkeypatch):
    """Dependency clones land in this test's own workspace."""
    ws = tmp_path / "workspace"
    ws.mkdir()
    monkeypatch.setattr("flow_sdk.fs_store.origin.git_origin._workspace", lambda: ws)
    project_dependencies._DISMISSED.clear()
    return ws


@pytest.fixture
def helpdesk_repo(tmp_path: Path) -> str:
    """The vendor's capability layer — stays theirs, keeps updating. A git source."""
    root = tmp_path / "vendor-helpdesk"
    desk = root / "agentic-assets" / "helpdesk" / "cloudnsite"
    desk.mkdir(parents=True)
    (desk / "helpdesk.json").write_text(json.dumps(DESK_MANIFEST), encoding="utf-8")
    _commit(root)
    return f"git+file://{root}"


def _template(root: Path, declaration: dict | None) -> str:
    """A template repo at ``root`` declaring ``declaration`` as its flow.json."""
    root.mkdir(parents=True)
    if declaration is not None:
        (root / "flow.json").write_text(json.dumps(declaration), encoding="utf-8")
    (root / "docs").mkdir()
    (root / "docs" / "00-discovery.md").write_text("# Discovery\n", encoding="utf-8")
    _commit(root)
    return f"file://{root}"


@pytest.fixture
def bootstrap_repo(tmp_path: Path, helpdesk_repo: str) -> str:
    """The engagement template — becomes the customer's on clone."""
    return _template(
        tmp_path / "vendor-bootstrap",
        {"dependencies": {"cloudnsite": helpdesk_repo}, "autolaunchJourney": "engagement-setup"},
    )


async def _project(name: str = "customer-engagement") -> Project:
    project = Project(name=unique_project_name(name))
    await project.save()
    return project


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, capture_output=True, text=True, timeout=20
    ).stdout.strip()


def _deps(data: dict) -> dict[str, dict]:
    return {d["name"]: d for d in data["dependencies"]}


@pytest.mark.parametrize(
    "body",
    [None, "", "{not json", "[]", '"a string"', '{"dependencies": "not-a-map"}', '{"dependencies": {"x": 1}}'],
    ids=["missing", "empty", "invalid", "array", "scalar", "wrong-type", "non-source"],
)
def test_a_hostile_or_broken_flow_json_declares_nothing(tmp_path: Path, body) -> None:
    """This file comes from a third-party repo. The reader setup uses must
    degrade to "declares nothing" rather than fail a setup that is half done."""
    if body is not None:
        (tmp_path / "flow.json").write_text(body, encoding="utf-8")
    assert flow_json.read(tmp_path) == flow_json.FlowJsonSpec()


# ── the flow ────────────────────────────────────────────────────────────────


@pytest.mark.long  # 1.14s
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


@pytest.mark.long  # 1.12s
@pytest.mark.asyncio
async def test_declared_helpdesk_is_attached_as_a_link_not_a_copy(bootstrap_repo: str) -> None:
    """The other half: what must NOT become the customer's.

    The desk resolves as a dependency pointing at the vendor's repo, so it keeps
    updating. A copy inside the project would freeze at clone time.
    """
    project = await _project()
    response = await project.setup_from_bootstrap_git(bootstrap_repo)
    assert response.status == "SUCCESS", response
    data = response.data

    desk = _deps(data)["cloudnsite"]
    assert desk["state"] == "ready", desk
    desk_path = Path(desk["local_path"])

    assert desk_path.is_dir()
    assert (desk_path / "agentic-assets" / "helpdesk" / "cloudnsite" / "helpdesk.json").is_file()
    assert desk["local_path"] in project.include_dirs, "must reach workers as a context dir"

    # Outside the project tree, and still a git checkout — that is what lets a
    # vendor-side change reach this engagement on a later pull.
    project_root = Path(data["path"]).resolve()
    assert project_root not in desk_path.resolve().parents, (
        "a desk copied INTO the project would freeze at clone time"
    )
    assert (desk_path / ".git").exists(), "the desk must stay linked to the vendor's repo"

    # The declaration itself survives the history cut: it is the customer's now.
    assert json.loads((Path(data["path"]) / "flow.json").read_text())["dependencies"] == {
        "cloudnsite": desk["source"]
    }
    assert data["autolaunch_journey"] == "engagement-setup"


@pytest.mark.asyncio
async def test_an_unreachable_desk_does_not_undo_a_finished_setup(tmp_path: Path) -> None:
    """A vendor's desk being down must not cost the customer their project —
    the files are already on disk and the failure is reportable."""
    url = _template(
        tmp_path / "bootstrap-bad-desk",
        {"dependencies": {"desk": f"git+file://{tmp_path / 'nope'}"}},
    )

    project = await _project()
    response = await project.setup_from_bootstrap_git(url)

    assert response.status == "SUCCESS", "the project itself succeeded"
    assert (Path(response.data["path"]) / "docs" / "00-discovery.md").is_file()
    desk = _deps(response.data)["desk"]
    assert desk["state"] == "unreachable", "the failure must be reported, not swallowed"
    assert project.include_dirs == []
    assert [w.name for w in await project.dependency_warnings()] == ["desk"]


@pytest.mark.asyncio
async def test_a_partial_resolve_links_what_landed_and_reports_the_rest(
    tmp_path: Path, helpdesk_repo: str
) -> None:
    url = _template(
        tmp_path / "bootstrap-partial",
        {"dependencies": {"desk": helpdesk_repo, "gone": f"git+file://{tmp_path / 'missing-second'}"}},
    )
    project = await _project()
    response = await project.setup_from_bootstrap_git(url)

    assert response.status == "SUCCESS", response
    deps = _deps(response.data)
    assert (deps["desk"]["state"], deps["gone"]["state"]) == ("ready", "unreachable")
    assert project.include_dirs == [deps["desk"]["local_path"]]


@pytest.mark.asyncio
async def test_a_template_with_no_flow_json_is_an_ordinary_template(tmp_path: Path) -> None:
    """Declaring a desk is optional — a plain repo must still work as a
    template, or every template author is forced into the mechanism."""
    url = _template(tmp_path / "plain-template", None)

    project = await _project()
    response = await project.setup_from_bootstrap_git(url)

    assert response.status == "SUCCESS", response
    assert (Path(response.data["path"]) / "docs" / "00-discovery.md").is_file()
    assert response.data["dependencies"] == []
    assert response.data["autolaunch_journey"] is None
    assert response.data["template_url"]


@pytest.mark.long  # 1.58s
@pytest.mark.asyncio
async def test_resolving_again_links_the_desk_once(bootstrap_repo: str, workspace: Path) -> None:
    """Re-opening an engagement re-resolves; it must converge, not pile up links
    or clones."""
    project = await _project()
    response = await project.setup_from_bootstrap_git(bootstrap_repo)
    first = _deps(response.data)["cloudnsite"]

    again = {s.name: s for s in await project.resolve_dependencies()}

    assert again["cloudnsite"].local_path == first["local_path"]
    assert project.include_dirs == [first["local_path"]]
    desk_clones = [d for d in workspace.iterdir() if d.name.startswith("vendor-helpdesk")]
    assert desk_clones == [Path(first["local_path"])], "the desk was cloned once"


@pytest.mark.long  # 1.25s
@pytest.mark.asyncio
async def test_the_checkout_is_named_after_the_engagement_not_the_template(
    bootstrap_repo: str,
) -> None:
    """A customer whose working folder is called ``vendor-bootstrap`` has been
    handed the vendor's name for their own work."""
    project = await _project("northwind-support")
    response = await project.setup_from_bootstrap_git(bootstrap_repo)

    leaf = Path(response.data["path"]).name
    assert "bootstrap" not in leaf, "the template's name must not become the customer's"
    # ``startswith``, not equality: the test workspace is shared across runs, so
    # earlier engagements leave real (non-empty) directories behind and a
    # suffix here is legitimate. The empty-reservation rule that made EVERY
    # engagement suffix is pinned hermetically in
    # ``test_an_empty_reservation_is_not_a_collision``.
    assert leaf.startswith("northwind-support"), leaf


def test_an_empty_reservation_is_not_a_collision(workspace: Path) -> None:
    """A Project reserves ``<workspace>/<name>`` when it is constructed.

    Treating that empty reservation as taken renamed every engagement to
    ``<name>-2`` AND stranded the reservation, which the workspace scan then
    minted a second, empty project for — two identically-named projects in the
    picker, with the customer's work in the suffixed one.
    """
    from flow_sdk.fs_store.origin.git_origin import fresh_clone_slot

    # ``workspace`` (the autouse fixture) is the root fresh_clone_slot picks under.

    # Nothing there yet → the plain name.
    assert fresh_clone_slot("acme").name == "acme"

    # An EMPTY directory is not a collision: nothing can be lost, and
    # ``git clone`` writes into one happily.
    (workspace / "acme").mkdir()
    assert fresh_clone_slot("acme").name == "acme"
    # …unless the caller needs a name nothing has claimed at all (a 409 suggestion).
    assert fresh_clone_slot("acme", reuse_empty=False).name == "acme-2"

    # A directory with contents IS a collision — that is somebody's work.
    (workspace / "acme" / "README.md").write_text("theirs", encoding="utf-8")
    assert fresh_clone_slot("acme").name == "acme-2"


@pytest.mark.long  # 2.56s
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
    assert _deps(ra.data)["cloudnsite"]["local_path"] == _deps(rb.data)["cloudnsite"]["local_path"]


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
