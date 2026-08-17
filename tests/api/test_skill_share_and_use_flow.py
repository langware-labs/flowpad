"""Share & use: one project publishes a skill, another consumes and runs it.

The whole journey, with a REAL git repo rather than a stubbed origin:

  1. ``skill-temp-project`` is created and a skill is authored inside it.
  2. The project is published — ``git-ops/init`` then ``git-ops/push``, both
     through the product's own action surface.
  3. ``user-temp-project`` attaches the published repo as a SHARED context
     folder, which is only legal because step 2 gave it a transportable
     ``GitOrigin``.
  4. The skill is indexed, attributed, and reaches a worker in the consuming
     project through ``resolved_add_dirs`` → ``--add-dir``.

Why this exists next to ``tests/unit/test_project_context_folders.py``: that
suite stubs ``Folder.detect_origin`` so shared-scope adds are exercisable
without a repo. That is the right call for unit-testing the buckets, but it
means the thing this flow actually depends on — that publishing to git is what
makes a folder shareable — is never exercised. Here the origin is detected off
a real remote, so ``git init`` alone is provably not enough.

The remote in ``_publish`` is made by this test, not by the product — see
``test_publishing_needs_a_remote_no_action_can_create`` for why.
"""

from __future__ import annotations

import os
import subprocess
import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.builtin.folder import Folder
from flow_sdk.builtin.project import Project
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.fs_store.path_utils import canonical_posix_path
from flow_sdk.responses.response import ApiResponse
from tests.api.conftest import create_agentic_process, default_compute_node_id

SKILL_NAME = "greeter"


# Identity for the commit `git-ops/push` makes. Passed as env rather than two
# `git config` calls, so the checkout needs no setup of its own and a developer's
# global git identity can't leak into the assertions.
_GIT_ENV = {
    "GIT_AUTHOR_NAME": "Flow Test",
    "GIT_AUTHOR_EMAIL": "flow@test.local",
    "GIT_COMMITTER_NAME": "Flow Test",
    "GIT_COMMITTER_EMAIL": "flow@test.local",
}


def _git(*args: str, cwd: Path) -> str:
    """Run git, failing loudly — a silent setup failure would masquerade as a
    product bug in whichever assertion tripped next."""
    proc = subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        timeout=60,
        env={**os.environ, **_GIT_ENV},
    )
    assert proc.returncode == 0, f"git {' '.join(args)} failed:\n{proc.stdout}\n{proc.stderr}"
    return proc.stdout.strip()


def _author_skill(project_root: Path, name: str = SKILL_NAME) -> Path:
    """Write a skill the way a user would — the folder shape the indexer and
    the worker's ``--add-dir`` discovery both key off."""
    skill_dir = project_root / ".claude" / "skills" / name
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(
        "---\n"
        f"name: {name}\n"
        "description: >-\n"
        "  Greet a person by name in the house style. Use when the user asks for\n"
        "  a greeting, a welcome line, or an intro blurb for someone.\n"
        "---\n\n"
        f"# {name.title()}\n\n"
        "Reply with: `Greetings, <name>! The house style is warm and brief.`\n",
        encoding="utf-8",
    )
    return skill_dir


def _make_repo(root: Path) -> Path:
    """A publishable checkout: a work tree plus the bare repo that stands in
    for the hosted remote.

    The remote is created HERE, not by the product — see the dedicated test
    below. Bare-and-local keeps the push hermetic (no network, no auth).
    """
    remote = root.parent / f"{root.name}-remote.git"
    subprocess.run(["git", "init", "--bare", str(remote)], capture_output=True, check=True)
    return remote


async def _publish(client, node_id: str, workdir: Path, remote: Path) -> dict:
    """Publish through the product: ``git-ops/init`` then ``git-ops/push``."""
    base = f"/api/v1/graph/compute_node/{node_id}/git-ops"
    init = await client.post(f"{base}/init", json={"workdir": str(workdir)})
    assert init.status_code == 200, init.text

    # Stands in for the git-setup wizard — the product's only route to a remote.
    # See `test_publishing_needs_a_remote_no_action_can_create`.
    #
    # `file://` and not a bare path: `parse_git_origin_url` reads the scheme to
    # classify a remote, and a path with no scheme has no host, so it yields no
    # origin at all — the folder would stay local and unshareable despite having
    # a working remote.
    _git("remote", "add", "origin", remote.as_uri(), cwd=workdir)

    push = await client.post(f"{base}/push", json={"workdir": str(workdir)})
    assert push.status_code == 200, push.text
    return ApiResponse(**push.json()).data


@pytest.mark.asyncio
async def test_skill_shared_by_git_is_usable_from_another_project(
    bootstrapped_client, user, bootstrap_payload, tmp_path
):
    node_id = default_compute_node_id(bootstrap_payload)

    # 1 — the producing project, with a skill in it.
    producer_root = tmp_path / "skill-temp-project"
    producer_root.mkdir()
    producer = Project(name="skill-temp-project", fs_storage_mount_path=str(producer_root))
    await producer.save()
    skill_dir = _author_skill(producer_root)

    # 2 — publish it.
    remote = _make_repo(producer_root)
    pushed = await _publish(bootstrapped_client, node_id, producer_root, remote)
    assert pushed.get("success") is not False, pushed
    # The commit really landed on the remote, not just locally.
    assert _git("log", "--oneline", "-1", cwd=producer_root)
    assert SKILL_NAME in _git(
        "ls-tree", "-r", "--name-only", "HEAD", cwd=producer_root
    ), "the skill was not committed"

    # Publishing is what makes the folder transportable. Without the remote it
    # would still be a LocalOrigin and step 3 would be refused.
    origin = await Folder.detect_origin(canonical_posix_path(str(producer_root)))
    assert origin.kind == "git", f"expected a git origin after publish, got {origin.kind}"
    assert origin.transportable is True

    # 3 — the consuming project attaches it as a SHARED context folder.
    consumer_root = tmp_path / "user-temp-project"
    consumer_root.mkdir()
    consumer = Project(name="user-temp-project", fs_storage_mount_path=str(consumer_root))
    await consumer.save()

    resp = await bootstrapped_client.post(
        f"/api/v1/graph/project/{consumer.id}/add-context-dir",
        json={"path": str(producer_root), "scope": "shared"},
    )
    assert resp.status_code == 200, resp.text

    consumer = await Project.get_by_id(consumer.id)
    canonical_producer = canonical_posix_path(str(producer_root))
    assert canonical_producer in consumer.include_dirs

    # The link is git-backed, which is what lets it travel with the project.
    infos = {i["path"]: i for i in consumer.context_dir_infos}
    assert infos[canonical_producer]["origin_kind"] == "git"

    # 4 — the skill is indexed, and attributed to the project that LINKED it.
    #
    # `add-context-dir` kicks a one-shot scan, so the skill becomes a real entity.
    indexed = await Entity.get_by_asset_ref(canonical_posix_path(str(skill_dir)))
    assert indexed is not None, "the context folder's skill was never indexed"
    assert indexed.type == "skill"
    assert (indexed.name or "").lower() == SKILL_NAME

    # Attribution goes to the CONSUMER — the project that linked the folder —
    # even though the skill lives inside the producer's tree.
    #
    # The mechanism is the REQUEST scope, not the path: `_resolve_scope_project`
    # (entity_model) stamps an empty `project_id` from the project the save is
    # scoped under, which here is the `POST /graph/project/<consumer>/
    # add-context-dir` endpoint that triggered the scan. Its stated purpose is
    # to make the entity "visible in project-scoped surfaces immediately, not
    # only after the next indexer walk" — so the consumer seeing the skill it
    # just added is the intent, not a side effect.
    #
    # Note for anyone chasing this: the path-based rule
    # (`deepest_project_id_for_path`, "the DEEPEST project whose mount contains
    # path owns it") never runs for this record — `project_mounts` is empty
    # unless the roots are nested, and these two are siblings. The two rules
    # only compete when a later walk re-derives a project_id that is already set.
    assert indexed.project_id == consumer.id, (
        f"expected the linking project ({consumer.id}) to own the indexed skill, "
        f"got {indexed.project_id}"
    )

    # 5 — the skill reaches a worker in the CONSUMING project.
    pid = await create_agentic_process(
        bootstrapped_client,
        visible=False,
        pty_mode=False,
        workdir=str(consumer_root),
        project_id=consumer.id,
    )
    process = await AgenticProcess.get_by_id(pid)
    await process.get_project()  # stamps _project_context_dirs, as launch does
    assert canonical_producer in process.resolved_add_dirs, (
        "the published folder is not mounted for the consuming project's worker"
    )


@pytest.mark.asyncio
async def test_publishing_needs_a_remote_no_action_can_create(
    bootstrapped_client, user, bootstrap_payload, tmp_path
):
    """`git init` alone leaves the folder unshareable, and no ACTION fixes it.

    The gap the flow runs into: ``git-ops`` inits and pushes, but creating the
    ``origin`` remote exists only as an agent wizard (``git-context-folder``),
    never as a deterministic action. So a freshly-initialised project stays a
    ``LocalOrigin`` and ``add-context-dir`` refuses to share it — anything
    non-interactive (a test, a script, the backend itself) is stuck here.

    Worth knowing if that wizard is ever replaced by an action: the folder must
    be RE-MINTED afterwards, not mutated. A Folder's identity is its origin key,
    so a directory that becomes git-backed keeps its stale ``LocalOrigin``
    forever unless it is removed and re-added (``use-git-share-gate.runSetup``
    does exactly that today).
    """
    node_id = default_compute_node_id(bootstrap_payload)
    root = tmp_path / "unpublished"
    root.mkdir()
    _author_skill(root)

    init = await bootstrapped_client.post(
        f"/api/v1/graph/compute_node/{node_id}/git-ops/init", json={"workdir": str(root)}
    )
    assert init.status_code == 200, init.text

    origin = await Folder.detect_origin(canonical_posix_path(str(root)))
    assert origin.kind == "local", "a repo with no remote should not look transportable"

    consumer = Project(name=f"needs-remote-{uuid.uuid4().hex[:6]}", fs_storage_mount_path=str(tmp_path))
    await consumer.save()
    resp = await bootstrapped_client.post(
        f"/api/v1/graph/project/{consumer.id}/add-context-dir",
        json={"path": str(root), "scope": "shared"},
    )
    assert ApiResponse(**resp.json()).status == "FAIL"
    assert "git-backed" in (ApiResponse(**resp.json()).message or "")

    # Private still works — the degenerate path that skips what sharing is for.
    private = await bootstrapped_client.post(
        f"/api/v1/graph/project/{consumer.id}/add-context-dir",
        json={"path": str(root), "scope": "private"},
    )
    assert private.status_code == 200, private.text
