"""macOS TCC regression: the indexer must not walk a project that lives inside
a macOS-protected folder (~/Documents, ~/Desktop, ~/Downloads, ~/Pictures,
~/Movies, ~/Music).

Symptom (observed by the user on launch): "Flowpad would like to access files
in your Documents folder" / "…Desktop folder" / "…media library". macOS fires a
TCC prompt on the FIRST filesystem read of anything under a protected folder,
at any depth. The launch-time full-scope scan resolves EVERY known project's cwd
into a REAL_PROJECT_CWD walk root via ``_resolve_scoped_roots`` and hands each to
``project_folder_walker_fn``, which recurses it — so a project mounted at
``~/Documents/dev/flowpad-oss`` is walked, reading under ~/Documents → the prompt.

Proven switch (this session, repro_tcc.py): ``project_folder_walker_fn(root=X)``
reads a protected subdir iff X is at/inside it. The only production guard is
``is_home_or_ancestor``, which blocks $HOME-and-above but NOT a mount nested
inside a protected folder — that is the gap this test pins.

No mocks: real Project rows in the test DB + the real ``get_all_scope_filter``
(the launch input) + the real ``_resolve_scoped_roots`` + the real walker.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.builtin.faas.fs_records_actions import FsRecordsActionsMixin
from flow_sdk.builtin.project import Project
from flow_sdk.fs_store.indexer.functions.project_folder_walker import (
    project_folder_walker_fn,
)
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.operations.all_projects import (
    get_all_scope_filter,
    invalidate_projects_cache,
)
from flow_sdk.fs_store.indexer.special_folders import (
    STATE_ALLOW,
    STATE_ASK,
    STATE_DENIED,
    STATE_SKIP,
    IndexDecision,
    drain_pending_consent,
    indexing_decision,
)
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.preferences import write_instance_pref

# The root types the folder walker is registered on in production (builtin.py) —
# NOT USER_HOME_FOLDER, which is expanded only by narrow ~/.claude/* functions.
_WALKER_ROOT_TYPES = (
    RecordType.REAL_PROJECT_CWD,
    RecordType.CWD_ROOT,
    RecordType.SYSTEM_ROOT,
)

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

# The macOS TCC-gated home subfolders. First read under any of these prompts.
PROTECTED = ("Documents", "Desktop", "Downloads", "Pictures", "Movies", "Music")


class _Actions(FsRecordsActionsMixin):
    """Bare host for the real ``_resolve_scoped_roots`` — no other deps used."""


def _under_protected(path: Path, home: Path) -> str | None:
    """Return the protected-folder name if ``path`` is at/under one, else None."""
    for name in PROTECTED:
        prot = (home / name).resolve()
        p = path.resolve()
        if p == prot or prot in p.parents:
            return name
    return None


@pytest.mark.parametrize("folder", PROTECTED)
async def test_project_in_protected_folder_is_not_walked(
    folder: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One case per macOS-protected folder: a project mounted inside it must NOT
    become a walk root, and the walker must not read into it. Parametrized so the
    report shows exactly which folders leak (Documents/Desktop/Downloads/...)."""
    # Sandbox $HOME at tmp_path so <home>/<folder> is a real protected folder.
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", "test")
    monkeypatch.setenv("FLOWPAD_TEST_SANDBOX", str(tmp_path))
    from flow_sdk.instance_settings import reset_instance_settings

    reset_instance_settings()
    home = tmp_path

    # A real project the user keeps inside ~/<folder> (this repo's own shape:
    # ~/Documents/dev/flowpad-oss). Give it real content to walk.
    proj_root = home / folder / "dev" / "flowpad-oss"
    (proj_root / "src").mkdir(parents=True)
    (proj_root / "src" / "main.py").write_text("print('hi')\n")
    (proj_root / "README.md").write_text("# repo\n")

    proj = Project(
        id=Project.derive_id_for_path(str(proj_root)),
        name="flowpad-oss",
        fs_storage_mount_path=str(proj_root),
    )
    await proj.save()
    invalidate_projects_cache()

    # Launch input: the "walk user + every known project" scope filter. The real
    # ~/Documents/dev/flowpad-oss is not a temp path; our sandbox home lives under
    # /var/folders (macOS temp), so include_temp=True keeps the project in scope
    # exactly as a real non-temp project would be — the guard gap under test is
    # orthogonal to temp filtering.
    sf = await get_all_scope_filter(include_temp=True, create_missing=False)
    roots = await _Actions()._resolve_scoped_roots(sf)
    assert roots is not None

    # The guard must have dropped the Documents-nested project walk root...
    offending_roots = [
        str(r.path) for r in roots if _under_protected(Path(r.path), home)
    ]
    # ...and the walker (over only the roots it runs on in production) must never
    # emit a FOLDER inside a protected folder.
    walker_roots = [r for r in roots if r.record_type in _WALKER_ROOT_TYPES]
    walked = project_folder_walker_fn(walker_roots, IndexerOptions(gitignore=True))
    offending_walk = [
        f"{_under_protected(Path(f.path), home)}: {f.path}"
        for f in walked
        if _under_protected(Path(f.path), home)
    ]

    assert not offending_roots, (
        "indexer resolved a walk root inside a macOS-protected folder "
        f"(TCC prompt on launch): {offending_roots}"
    )
    assert not offending_walk, (
        "project_folder_walker_fn read inside a macOS-protected folder "
        f"(TCC prompt on launch): {offending_walk[:5]}"
    )


# ── preferences-state driven behavior ────────────────────────────────────────

async def _project_under(
    folder: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> tuple[Path, Path]:
    """Sandbox HOME at tmp_path, create a real Project at ~/<folder>/dev/proj."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", "test")
    monkeypatch.setenv("FLOWPAD_TEST_SANDBOX", str(tmp_path))
    from flow_sdk.instance_settings import reset_instance_settings

    reset_instance_settings()
    proj_root = tmp_path / folder / "dev" / "proj"
    (proj_root / "src").mkdir(parents=True)
    (proj_root / "README.md").write_text("# repo\n")
    proj = Project(
        id=Project.derive_id_for_path(str(proj_root)),
        name="proj",
        fs_storage_mount_path=str(proj_root),
    )
    await proj.save()
    invalidate_projects_cache()
    return tmp_path, proj_root


async def _resolve_for_all_projects():
    sf = await get_all_scope_filter(include_temp=True, create_missing=False)
    return await _Actions()._resolve_scoped_roots(sf)


@pytest.mark.parametrize(
    ("state", "expect_walked"),
    [
        (STATE_ALLOW, True),    # user approved → indexed
        (STATE_SKIP, False),    # user declined → skipped
        (STATE_DENIED, False),  # OS refused post-allow → skipped, not re-asked
        (STATE_ASK, False),     # undecided (default) → skipped, consent queued
    ],
)
async def test_preference_state_drives_documents_indexing(
    state: str, expect_walked: bool, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The persisted preferences.indexing.folders.documents state is what flips
    a Documents-nested project between indexed and skipped."""
    home, proj_root = await _project_under("Documents", tmp_path, monkeypatch)
    drain_pending_consent()  # clear any queue from earlier resolutions
    write_instance_pref("preferences.indexing.folders.documents", state)

    roots = await _resolve_for_all_projects()
    present = any(
        _under_protected(Path(r.path), home) for r in (roots or [])
    )
    assert present is expect_walked, (
        f"state={state}: expected walked={expect_walked}, got {present}"
    )


async def test_ask_state_queues_consent_event(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The undecided (default 'ask') state → decision ASK → a well-formed
    index_folder_consent event is queued for the frontend (deduped by folder)."""
    from flow_sdk.fs_store.indexer.special_folders import (
        CONSENT_EVENT_KIND,
        classify_special_folder,
        note_consent_needed,
    )

    _, proj_root = await _project_under("Documents", tmp_path, monkeypatch)
    drain_pending_consent()  # start clean
    assert indexing_decision(proj_root, foreground=False) is IndexDecision.ASK

    sf = classify_special_folder(proj_root)
    assert sf is not None and sf.category == "documents"
    note_consent_needed(sf, proj_root)
    note_consent_needed(sf, proj_root)  # dedup: still ONE event
    events = drain_pending_consent()
    assert len(events) == 1
    ev = events[0]
    assert ev["kind"] == CONSENT_EVENT_KIND
    assert ev["category"] == "documents"
    assert ev["os_prompts"] is True  # macOS test host
    assert not drain_pending_consent()  # queue cleared


async def test_allow_then_deny_is_not_reasked(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """denied is terminal: a denied folder neither walks nor re-queues a prompt."""
    home, _ = await _project_under("Documents", tmp_path, monkeypatch)
    drain_pending_consent()
    write_instance_pref("preferences.indexing.folders.documents", STATE_DENIED)
    roots = await _resolve_for_all_projects()
    assert not any(_under_protected(Path(r.path), home) for r in (roots or []))
    assert not drain_pending_consent()


async def test_foreground_open_walks_even_when_ask(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An explicit user open (foreground) indexes the project regardless of the
    folder's tri-state — one expected OS prompt, no gate."""
    home, proj_root = await _project_under("Documents", tmp_path, monkeypatch)
    # default state is 'ask'; background would skip, foreground must walk.
    sf = await get_all_scope_filter(include_temp=True, create_missing=False)
    bg = await _Actions()._resolve_scoped_roots(sf, foreground=False)
    fg = await _Actions()._resolve_scoped_roots(sf, foreground=True)
    assert not any(_under_protected(Path(r.path), home) for r in (bg or []))
    assert any(_under_protected(Path(r.path), home) for r in (fg or []))


async def test_media_folder_is_hardskip_regardless_of_pref(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Media (Music/Movies/Pictures) is never indexed — even an explicit allow
    or a foreground open cannot turn it on (no kTCCServiceMediaLibrary prompt)."""
    home, music_proj = await _project_under("Music", tmp_path, monkeypatch)
    # There is no pref key for media; force one anyway to prove it's ignored.
    write_instance_pref("preferences.indexing.folders.media", STATE_ALLOW)
    assert indexing_decision(music_proj, foreground=True) is IndexDecision.SKIP
    sf = await get_all_scope_filter(include_temp=True, create_missing=False)
    fg = await _Actions()._resolve_scoped_roots(sf, foreground=True)
    assert not any(_under_protected(Path(r.path), home) for r in (fg or []))
