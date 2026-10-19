"""``is_protected_path`` resolves its policy ROOTS once, not on every call.

Home, the workspace root, the temp roots, flow home and the records roots are
the same handful of paths for every candidate, and resolving them was seven of
the eight ``Path.resolve`` a call made. They are memoized on their own text, so
the answers must still follow the settings, ``$HOME`` and the temp env the
moment those change.
"""

import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from flow_sdk.fs_store import path_utils
from flow_sdk.fs_store.path_utils import _root_key, _same_flavour_key, is_protected_path, is_valid_project_cwd


def _settings(base: Path) -> SimpleNamespace:
    home = base / "home"
    flow_home = home / ".flow"
    for folder in (home / "Flowpad workspaces" / "t", flow_home / "instances" / "t" / "records", home / "code" / "proj"):
        folder.mkdir(parents=True)
    return SimpleNamespace(
        user_home=home,
        workspace_root=home / "Flowpad workspaces" / "t",
        flow_home=flow_home,
        records_root=flow_home / "instances" / "t" / "records",
        records_data_dir=flow_home / "instances" / "t" / "records",
    )


@pytest.fixture
def use_settings(monkeypatch):
    def use(settings: SimpleNamespace) -> SimpleNamespace:
        monkeypatch.setattr("flow_sdk.instance_settings.get_instance_settings", lambda: settings)
        return settings

    return use


def _verdicts(settings: SimpleNamespace) -> dict[str, bool]:
    home = settings.user_home
    return {
        "home": is_protected_path(home),
        "above home": is_protected_path(home.parent),
        "workspace root": is_protected_path(settings.workspace_root),
        "flow home": is_protected_path(settings.flow_home),
        "a record": is_protected_path(settings.records_root / "task" / "x"),
        "legacy records": is_protected_path(home / "flow" / "records" / "y"),
        "a project": is_protected_path(home / "code" / "proj"),
        "a project is a valid cwd": is_valid_project_cwd(home / "code" / "proj", include_temp=True),
    }


EXPECTED = {
    "home": True, "above home": True, "workspace root": True, "flow home": True, "a record": True,
    "legacy records": True, "a project": False, "a project is a valid cwd": True,
}  # fmt: skip


def test_a_warm_call_resolves_only_the_candidate(tmp_path: Path, use_settings, monkeypatch):
    settings = use_settings(_settings(tmp_path))
    assert _verdicts(settings) == EXPECTED

    resolved: list[str] = []
    real = path_utils.canonical_posix_path
    monkeypatch.setattr(path_utils, "canonical_posix_path", lambda p: resolved.append(str(p)) or real(p))
    project = settings.user_home / "code" / "proj"

    assert is_protected_path(project) is False
    assert resolved == [str(project)]
    del resolved[:]
    # The cwd gate needs the candidate's key too, and takes it from the same resolution.
    assert is_valid_project_cwd(project, include_temp=True) is True
    assert resolved == [str(project)]


def test_changed_settings_are_never_answered_from_the_previous_roots(tmp_path: Path, use_settings):
    first, second = _settings(tmp_path / "one"), _settings(tmp_path / "two")
    use_settings(first)
    assert _verdicts(first) == EXPECTED
    # Under the first settings the second home is just a folder somewhere.
    assert is_protected_path(second.flow_home) is False

    use_settings(second)
    assert _verdicts(second) == EXPECTED
    assert is_protected_path(first.flow_home) is False
    assert is_protected_path(first.workspace_root) is False


def test_temp_roots_follow_the_environment(tmp_path: Path, use_settings, monkeypatch):
    use_settings(_settings(tmp_path))
    for name in ("one", "two"):
        scratch = tmp_path / name
        scratch.mkdir()
        monkeypatch.setenv("TMPDIR", str(scratch))
        assert is_protected_path(scratch) is True
        assert is_valid_project_cwd(scratch / "work") is False
    monkeypatch.delenv("TMPDIR")
    assert is_protected_path(tmp_path / "one") is False


def test_a_root_key_is_the_uncached_key_and_tilde_follows_home(tmp_path: Path, monkeypatch):
    (tmp_path / "real").mkdir()
    (tmp_path / "link").symlink_to(tmp_path / "real", target_is_directory=True)
    for raw in (tmp_path / "link", str(tmp_path / "missing"), "relative/root", "C:\\Users\\Me", "", "~/x"):
        for flavour in ("posix", "windows"):
            assert _root_key(raw, flavour) == _same_flavour_key(raw, flavour), (raw, flavour)
    assert _root_key(tmp_path / "link", "posix") == _same_flavour_key(tmp_path / "real", "posix")

    for name in ("h1", "h2"):
        monkeypatch.setenv("HOME", str(tmp_path / name))
        assert _root_key("~/x", "posix") == _same_flavour_key(os.path.join(tmp_path, name, "x"), "posix")
