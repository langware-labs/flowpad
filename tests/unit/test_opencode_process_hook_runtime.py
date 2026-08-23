"""OpenCode process-hook projection.

OpenCode is the odd vendor: its hook artifact is **generated JavaScript**, and it
reaches the worker through the generated ``opencode.json`` rather than argv —
there is no plugin CLI flag. So the assertions here differ from the other three
drivers in two ways: the ``ProcessHookRuntime`` must come back EMPTY, and the
config generator must pick the plugin up out of the same assets dir.

Everything asserted here was measured against opencode 1.18.18 before it was
written — notably that ``$`` has no ``.stdin()`` method, so the report must be a
shell pipeline.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agentic_process.asset_dir import AssetDir
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import ProcessHookRuntime
from flow_sdk.builtin.agentic_process.cli_drivers.opencode.config_gen import config_for_assets_dir
from flow_sdk.builtin.agentic_process.cli_drivers.opencode.driver import OpenCodeDriver
from flow_sdk.builtin.agentic_process.cli_drivers.opencode.hook_plugin import (
    PLUGIN_SUBDIR,
    plugin_path,
)
from flow_sdk.builtin.flowpad_runner_wrapper import get_installed_flow_invocation, get_wrapper_path
from flow_sdk.builtin.hooks.types import HookEventType
from flow_sdk.instance_settings import reset_instance_settings

EVENTS = (HookEventType.USER_PROMPT_SUBMIT, HookEventType.SESSION_START)


@pytest.fixture()
def isolated_wrapper(tmp_path, monkeypatch):
    monkeypatch.setenv("FLOWPAD_TEST_SANDBOX", str(tmp_path / "sandbox with space"))
    # FLOW_HOME, not FLOWPAD_TEST_SANDBOX, is what moves ``flow_home``.
    monkeypatch.setenv("FLOW_HOME", str(tmp_path / "flow home"))
    reset_instance_settings()
    yield
    reset_instance_settings()


def _project(assets: AssetDir, process_id: str, events=EVENTS) -> ProcessHookRuntime:
    return OpenCodeDriver().prepare_process_hooks(assets, process_id, list(events))


def test_projection_writes_the_plugin_and_adds_nothing_to_argv(tmp_path, isolated_wrapper):
    process_id = str(mint_uuid())
    assets = AssetDir(tmp_path)

    runtime = _project(assets, process_id)

    # THE distinguishing property: opencode has no plugin flag, so there is
    # nothing to contribute to the command line.
    assert runtime == ProcessHookRuntime()
    assert runtime.plugin_dirs == ()
    assert runtime.config_overrides == ()

    source = plugin_path(tmp_path).read_text(encoding="utf-8")
    assert process_id in source
    command, prefix = get_installed_flow_invocation()
    assert command in source
    assert "hooks report --process-id" in source
    # Both declared events are wired: one named hook, one firehose filter.
    assert '"chat.message": "UserPromptSubmit"' in source
    assert '"session.created": "SessionStart"' in source

    # Projecting must not materialize a global runner wrapper.
    assert not get_wrapper_path().exists()


def test_the_report_is_a_pipeline_because_the_shell_has_no_stdin_method(tmp_path, isolated_wrapper):
    """Measured against opencode 1.18.18: ``$`…`.stdin`` is undefined.

    ``flow hooks report`` reads its payload from stdin, so the only way to feed
    it is a shell pipeline. If someone "simplifies" this back to ``.stdin(...)``
    every opencode hook silently throws at runtime.
    """
    _project(AssetDir(tmp_path), str(mint_uuid()))
    source = plugin_path(tmp_path).read_text(encoding="utf-8")

    # Strip comments: the generated source EXPLAINS why .stdin() is unusable,
    # so a naive substring check would match the explanation.
    code = "\n".join(
        line for line in source.splitlines() if not line.lstrip().startswith("//")
    )

    assert "| ${FLOW_ARGV} hooks report" in code
    assert ".stdin(" not in code


def test_projection_is_byte_identical_on_reprojection(tmp_path, isolated_wrapper):
    process_id = str(mint_uuid())
    assets = AssetDir(tmp_path)

    _project(assets, process_id)
    first = plugin_path(tmp_path).read_bytes()
    # Event ORDER must not change the output either — the set is what matters.
    _project(assets, process_id, events=tuple(reversed(EVENTS)))

    assert plugin_path(tmp_path).read_bytes() == first


def test_the_generated_config_lists_the_plugin_as_a_url(tmp_path, isolated_wrapper):
    process_id = str(mint_uuid())
    _project(AssetDir(tmp_path), process_id)

    config_file = config_for_assets_dir(process_id, tmp_path)

    assert config_file is not None, (
        "a process with hooks but no instructions/skills must STILL get a config — "
        "otherwise OPENCODE_CONFIG points nowhere and the plugin never loads"
    )
    config = json.loads(Path(config_file).read_text(encoding="utf-8"))
    # A bare path is read as an npm module specifier; it has to be a URL.
    assert config["plugin"] == [plugin_path(tmp_path).as_uri()]
    assert config["plugin"][0].startswith("file://")


def test_removing_every_event_removes_the_plugin_and_the_config_entry(tmp_path, isolated_wrapper):
    process_id = str(mint_uuid())
    assets = AssetDir(tmp_path)
    _project(assets, process_id)
    assert plugin_path(tmp_path).exists()

    _project(assets, process_id, events=())

    assert not plugin_path(tmp_path).exists()
    assert not (tmp_path / PLUGIN_SUBDIR).exists()
    assert config_for_assets_dir(process_id, tmp_path) is None


def test_an_event_opencode_cannot_serve_is_refused(tmp_path, isolated_wrapper):
    """``SessionEnd`` is in the shared V1 set but NOT in opencode's declaration.

    opencode's ``session.idle`` fires at turn end, not session end, so there is
    no honest mapping — and a stale row must not render a dead handler.
    """
    with pytest.raises(ValueError, match="SessionEnd"):
        _project(AssetDir(tmp_path), str(mint_uuid()), events=(HookEventType.SESSION_END,))


def test_an_invalid_process_id_is_refused(tmp_path, isolated_wrapper):
    with pytest.raises(ValueError, match="Invalid agentic process id"):
        _project(AssetDir(tmp_path), "not-a-uuid")


def test_normalize_rejects_an_undeclared_event():
    driver = OpenCodeDriver()
    process_id = str(mint_uuid())

    canonical = driver.normalize_process_hook_data(
        process_id, {"hook_event_name": "UserPromptSubmit", "prompt": "hi"}
    )
    assert canonical.agentic_process_id == process_id
    assert canonical.hook_data["hook_event_name"] == "UserPromptSubmit"
    assert canonical.hook_data["prompt"] == "hi"
    assert canonical.hook_data["raw_hook_data"]["prompt"] == "hi"

    with pytest.raises(ValueError, match="SessionEnd"):
        driver.normalize_process_hook_data(process_id, {"hook_event_name": "SessionEnd"})
