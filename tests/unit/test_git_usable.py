"""git_usable: never wake macOS's "install the developer tools" dialog from a background probe."""

import subprocess

import pytest

from flow_sdk.utils import git as git_utils
from flow_sdk.utils import git_usable as gu

CLT = "/Library/Developer/CommandLineTools/usr/bin/git"
_SELECTED = gu._selected_developer_git  # the real cached function; tests replace the module attribute


@pytest.fixture(autouse=True)
def _fresh_cache():
    _SELECTED.cache_clear()
    yield
    _SELECTED.cache_clear()


def _mac(monkeypatch, *, which="/usr/bin/git", existing=(), selected=None):
    monkeypatch.setattr(gu.sys, "platform", "darwin")
    monkeypatch.setattr(gu.shutil, "which", lambda _name: which)
    monkeypatch.setattr(gu.os.path, "exists", lambda p: p in existing)
    monkeypatch.setattr(gu, "_selected_developer_git", lambda: selected)


def test_always_usable_off_macos(monkeypatch):
    monkeypatch.setattr(gu.sys, "platform", "linux")
    assert gu.git_usable() is True


def test_stub_without_tools_is_not_usable(monkeypatch):
    _mac(monkeypatch)
    assert gu.git_usable() is False


def test_command_line_tools_make_it_usable(monkeypatch):
    _mac(monkeypatch, existing={CLT})
    assert gu.git_usable() is True


def test_full_xcode_makes_it_usable(monkeypatch):
    _mac(monkeypatch, existing={"/Applications/Xcode.app/Contents/Developer/usr/bin/git"})
    assert gu.git_usable() is True


def test_homebrew_git_is_usable_without_the_tools(monkeypatch):
    _mac(monkeypatch, which="/opt/homebrew/bin/git")
    assert gu.git_usable() is True


def test_a_non_default_developer_directory_is_found(monkeypatch):
    _mac(monkeypatch, existing={"/opt/dev/usr/bin/git"}, selected="/opt/dev/usr/bin/git")
    assert gu.git_usable() is True


def test_selected_directory_without_git_is_not_usable(monkeypatch):
    _mac(monkeypatch, selected="/opt/dev/usr/bin/git")
    assert gu.git_usable() is False


def test_xcode_select_missing_is_not_usable(monkeypatch):
    monkeypatch.setattr(gu.sys, "platform", "darwin")
    monkeypatch.setattr(gu.shutil, "which", lambda _name: "/usr/bin/git")
    monkeypatch.setattr(gu.os.path, "exists", lambda _p: False)

    def boom(*_a, **_k):
        raise FileNotFoundError("xcode-select")

    monkeypatch.setattr(gu.subprocess, "run", boom)
    assert gu.git_usable() is False


def test_run_git_does_not_spawn_when_unusable(monkeypatch):
    monkeypatch.setattr(git_utils, "git_usable", lambda: False)

    def must_not_run(*_a, **_k):
        raise AssertionError("git must not be spawned")

    monkeypatch.setattr(git_utils.subprocess, "run", must_not_run)
    result = git_utils._run_git(["git", "status"], ".")
    assert result.returncode == 127 and result.stdout == ""


def test_run_git_runs_when_usable(monkeypatch):
    monkeypatch.setattr(git_utils, "git_usable", lambda: True)
    seen = {}

    def fake_run(args, **kw):
        seen["args"] = args
        return subprocess.CompletedProcess(args, 0, "ok", "")

    monkeypatch.setattr(git_utils.subprocess, "run", fake_run)
    assert git_utils._run_git(["git", "status"], ".").stdout == "ok"
    assert seen["args"] == ["git", "status"]


# --- the other places that run git on their own (found in review of #585) -------------------------------------------


def _forbid_git(monkeypatch):
    def must_not_run(*_a, **_k):
        raise AssertionError("git must not be spawned on a Mac without the Command Line Tools")

    monkeypatch.setattr(subprocess, "run", must_not_run)


def test_hub_repo_sync_local_tree_does_not_spawn_git(monkeypatch, tmp_path):
    from flow_sdk.assets import hub_repo_sync

    monkeypatch.setattr("flow_sdk.utils.git_usable.git_usable", lambda: False)
    _forbid_git(monkeypatch)
    assert hub_repo_sync.local_tree(tmp_path / "mirror", tmp_path / "work", "a.md") is None


def test_detaching_a_template_does_not_run_git_init_when_unusable(monkeypatch, tmp_path):
    from flow_sdk.builtin import project

    (tmp_path / ".git").mkdir()
    monkeypatch.setattr("flow_sdk.utils.git_usable.git_usable", lambda: False)
    _forbid_git(monkeypatch)
    project._detach_git_history(tmp_path)
    assert not (tmp_path / ".git").exists(), "the old history is still removed; only the git init is skipped"


@pytest.mark.asyncio
async def test_docs_diff_does_not_run_git_show_when_unusable(monkeypatch, tmp_path):
    from flow_sdk.server.routes import docs_graph

    (tmp_path / "doc.md").write_text("hello\n")
    monkeypatch.setattr(docs_graph, "git_usable", lambda: False)
    _forbid_git(monkeypatch)
    result = await docs_graph.docs_graph_diff(root=str(tmp_path), rel="doc.md")
    assert result["status"] == "SUCCESS"
    assert "hello" in result["data"]["diff"], "with no baseline it still renders the file as added"


# --- the funnels everything else goes through ------------------------------------------------------------------------


class _RecordingNode:
    """Just enough of a ComputeNode for the executor and for ComputeSourceControl.initialize."""

    def __init__(self, provider):
        from contextlib import asynccontextmanager

        self.node_provider_type = provider
        self.commands: list[str] = []

        @asynccontextmanager
        async def ready_session():
            yield

        self.ready_session = ready_session

    async def run_command(self, command, **_kwargs):
        self.commands.append(command)

        class _Done:
            exit_code = 0
            all_stdout = "true"
            all_stderr = ""

            async def wait(self):
                return None

        return _Done()


def test_the_local_executor_answers_a_git_call_as_a_missing_binary(monkeypatch):
    from flow_sdk.utils.command_executor import _LocalCommandExecutor

    monkeypatch.setattr("flow_sdk.utils.command_executor.git_usable", lambda: False)
    _forbid_git(monkeypatch)
    result = _LocalCommandExecutor().run_sync(["git", "status"])
    assert result.returncode == 127 and "Command Line Tools" in result.stderr


def test_the_local_executor_still_runs_everything_that_is_not_git(monkeypatch):
    from flow_sdk.utils.command_executor import _LocalCommandExecutor

    monkeypatch.setattr("flow_sdk.utils.command_executor.git_usable", lambda: False)
    assert _LocalCommandExecutor().run_sync(["echo", "hi"]).stdout.strip() == "hi"


@pytest.mark.asyncio
async def test_the_node_executor_refuses_git_on_this_machine_but_not_on_a_remote_box(monkeypatch):
    from flow_sdk.builtin.faas.command_executor import ComputeNodeCommandExecutor
    from flow_sdk.config import ComputeProviderType

    monkeypatch.setattr("flow_sdk.builtin.faas.command_executor.git_usable", lambda: False)

    here = _RecordingNode(ComputeProviderType.LOCAL_MACHINE)
    refused = await ComputeNodeCommandExecutor(here).run(["git", "status"], cwd="/tmp/x")
    assert refused.returncode == 127 and here.commands == [], "nothing was sent to the node"

    remote = _RecordingNode(ComputeProviderType.E2B)
    await ComputeNodeCommandExecutor(remote).run(["git", "status"], cwd="/tmp/x")
    assert len(remote.commands) == 1, "a remote box has its own git; this Mac's tools say nothing about it"


@pytest.mark.asyncio
async def test_project_initialize_runs_no_git_on_a_mac_without_the_tools(monkeypatch):
    from flow_sdk.config import ComputeProviderType
    from flow_sdk.core.flow import flow_source_control as fsc

    monkeypatch.setattr(fsc, "git_usable", lambda: False)
    node = _RecordingNode(ComputeProviderType.LOCAL_MACHINE.value)
    async with fsc.ComputeSourceControl(compute_node=node).initialize(fsc.ComputeSourceControlInitializeOptions()):
        pass
    assert node.commands == [], f"git was run: {node.commands}"


@pytest.mark.asyncio
async def test_project_initialize_still_does_git_when_it_is_usable(monkeypatch):
    from flow_sdk.config import ComputeProviderType
    from flow_sdk.core.flow import flow_source_control as fsc

    monkeypatch.setattr(fsc, "git_usable", lambda: True)
    node = _RecordingNode(ComputeProviderType.LOCAL_MACHINE.value)
    async with fsc.ComputeSourceControl(compute_node=node).initialize(fsc.ComputeSourceControlInitializeOptions()):
        pass
    assert any("git" in c for c in node.commands)


@pytest.mark.asyncio
async def test_the_hub_mirror_says_git_is_missing_instead_of_opening_the_dialog(monkeypatch, tmp_path):
    from flow_sdk.assets import hub_repo_sync
    from flow_sdk.assets.git_publish import AssetPublishError

    monkeypatch.setattr(hub_repo_sync, "git_usable", lambda: False)
    mirror = hub_repo_sync.HubRepoMirror(root=tmp_path, clone_url="http://x", branch="main", token="t")
    with pytest.raises(AssetPublishError, match="Git is not installed"):
        await mirror.git("status")
