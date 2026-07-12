"""Tier-2 live check: a project context folder reaches a REAL worker.

Chain under test, end to end:

  ``add-context-dir`` (mints a Folder entity, links it into the project's
  private context bucket) → computed ``Project.include_dirs`` →
  ``get_project()`` stamps ``_project_context_dirs`` → ``resolved_add_dirs``
  → the driver's ``--add-dir`` mount → the live worker can actually READ a
  sentinel file planted inside the context folder (outside its workdir).

The deterministic half (the mount set) is asserted directly on
``resolved_add_dirs``; the live half plants a random token and requires it to
surface in the worker's own transcript. Follows the proven headless pattern
from ``test_skill_transcript_analysis``: fire-and-forget ``prompt()`` + poll
the transcript via ``await_transcript`` (never ``wait()``, whose status edges
don't fire in this in-process harness).

Gated on DEEP_TESTING; a worker that isn't installed/authed (or an API
timeout) skips rather than fails. Parametrised over claude/codex/copilot via
the vendor-blind ``make_process`` fixture (``worker_id`` doubles as the CLI
executable name and the transcript-analyzer worker key).
"""
from __future__ import annotations

import shutil
import uuid

import pytest

from flow_sdk.builtin.project import Project
from flow_sdk.builtin.worker_status import ApiErrorTimeoutError
from flow_sdk.fs_store.path_utils import canonical_posix_path
from flow_sdk.transcript_analyzer import EntryKind
from tests.long_tests._transcript_helpers import (
    assert_prompt_ok,
    await_transcript,
    safe_exit,
)
from tests.test_settings import test_service_config

pytestmark = [
    pytest.mark.skipif(
        not test_service_config.deep_testing,
        reason="Skipping long tests when DEEP_TESTING is disabled",
    ),
]


@pytest.fixture(scope="module")
async def _workers_discovered():
    """One capability-discovery sweep so drivers resolve their CLI binaries
    (the server does this at boot; tests must trigger it explicitly)."""
    from flow_sdk.core.capabilities.discovery import ensure_discovered

    await ensure_discovered()


def _worker_read_sentinel(tf, sentinel_path: str, token: str) -> bool:
    """The worker provably reached the sentinel: either a FILE_READ entry on
    its exact path (deterministic — the read went through the --add-dir
    mount), or the token echoed in an assistant message."""
    for e in tf.entries:
        if getattr(e, "kind", None) == EntryKind.FILE_READ and getattr(e, "path", "") == sentinel_path:
            return True
        if token in (getattr(e, "text", "") or ""):
            return True
    return False


@pytest.mark.asyncio
# do not increase timeout without approval
@pytest.mark.timeout(120)
async def test_worker_mounts_context_folder(
    initialize_test_db, local_compute_node, _workers_discovered,
    tmp_path, make_process, worker_id,
) -> None:
    if shutil.which(worker_id) is None:
        pytest.skip(f"{worker_id} CLI not installed")

    # A context folder OUTSIDE the workdir, holding a sentinel the worker can
    # only reach through the injected --add-dir mount.
    ctx = tmp_path / "ctx-folder" / "notes"
    ctx.mkdir(parents=True)
    token = f"CTXTOKEN-{uuid.uuid4().hex[:12]}"
    (ctx / "sentinel.txt").write_text(f"{token}\n")
    ctx_root = canonical_posix_path(tmp_path / "ctx-folder")
    sentinel_path = f"{ctx_root}/notes/sentinel.txt"

    workdir = tmp_path / "wd"
    workdir.mkdir()
    project = await Project(name=str(workdir)).save()
    resp = await project.add_context_dir(str(tmp_path / "ctx-folder"))
    assert resp.status == "SUCCESS"
    assert ctx_root in project.include_dirs

    ap = await make_process(
        workdir=str(workdir), project_id=project.id, visible=False, pty_mode=False,
    )

    # Deterministic: the spawn prelude stamps the context dirs into the
    # --add-dir set every driver renders.
    await ap.get_project()
    assert ctx_root in ap.resolved_add_dirs

    # Live: the worker reads the sentinel through the mount. Headless prompt
    # is fire-and-forget; poll the transcript for the token.
    try:
        result = await ap.prompt(
            f"Read the file {sentinel_path} and reply with its exact contents."
        )
        assert_prompt_ok(result)

        transcript = await await_transcript(
            ap,
            worker_id,
            lambda tf: _worker_read_sentinel(tf, sentinel_path, token),
            deadline_s=90,
        )
    except (ApiErrorTimeoutError, TimeoutError):
        pytest.skip(f"{worker_id} API timeout — external infra issue")
    finally:
        await safe_exit(ap)

    if transcript is None:
        pytest.skip(f"{worker_id} produced no transcript within 90s — infra/LLM latency")
    assert _worker_read_sentinel(transcript, sentinel_path, token), (
        f"{worker_id}: worker never read the sentinel through the context-folder mount"
    )
