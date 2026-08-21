from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.app.actions.listen import handle_process_agent_hook
from flow_sdk.builtin.agent_hook import HookEventType
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process import agentic_process as agentic_process_module
from flow_sdk.builtin.agentic_process.agentic_process import PreparedProcessAssets
from flow_sdk.builtin.agentic_process.cli_drivers import cli_worker_base_driver
from flow_sdk.builtin.agentic_process.cli_drivers.claude import driver as claude_driver_module
from flow_sdk.builtin.agentic_process.cli_drivers.claude.driver import ClaudeDriver
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import ProcessHookRuntime
from flow_sdk.builtin.agentic_process.cli_drivers.codex import driver as codex_driver_module
from flow_sdk.builtin.agentic_process.cli_drivers.codex.driver import CodexDriver
from flow_sdk.builtin.agentic_process.cli_drivers.copilot import driver as copilot_driver_module
from flow_sdk.builtin.agentic_process.cli_drivers.copilot.driver import CopilotDriver
from flow_sdk.builtin.agentic_process.process_hooks import (
    clear_process_hook_callbacks,
    dispatch_process_hook,
)
from flow_sdk.core import Entity
from flow_sdk.core.flow.models.webhook_flow_data import AgentHookData
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.fs_store.record_paths import get_default_records_root, set_default_records_root


@pytest.fixture(autouse=True)
def _clear_callbacks():
    clear_process_hook_callbacks()
    yield
    clear_process_hook_callbacks()


@pytest.fixture
def no_save(monkeypatch):
    async def save(entity):
        return entity

    monkeypatch.setattr(AgenticProcess, "save", save)


@pytest.fixture
def records_root(tmp_path):
    original = get_default_records_root()
    root = tmp_path / "records"
    set_default_records_root(root)
    yield root
    set_default_records_root(original)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "event",
    [HookEventType.USER_PROMPT_SUBMIT, HookEventType.SESSION_START, HookEventType.SESSION_END],
)
@pytest.mark.parametrize(
    "worker_type",
    [WorkerType.CLAUDE_CODE, WorkerType.CODEX, WorkerType.COPILOT],
)
async def test_set_and_remove_hook_are_idempotent(no_save, worker_type, event):
    process = AgenticProcess(id=mint_uuid(), worker_type=worker_type)

    assert await process.set_hook(event) is True
    assert await process.set_hook(event) is False
    assert process.process_hook_events == [event.value]
    assert await process.remove_hook(event) is True
    assert await process.remove_hook(event) is False
    assert process.process_hook_events == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "event",
    [HookEventType.PRE_TOOL_USE, HookEventType.STOP, HookEventType.NOTIFICATION],
)
@pytest.mark.parametrize(
    "worker_type",
    [WorkerType.CLAUDE_CODE, WorkerType.CODEX, WorkerType.COPILOT],
)
async def test_process_hooks_reject_every_other_event_before_mutation(no_save, worker_type, event):
    process = AgenticProcess(id=mint_uuid(), worker_type=worker_type)

    with pytest.raises(ValueError, match="unsupported process hook event"):
        await process.set_hook(event)

    assert process.process_hook_events == []
    assert process.process_assets is None


@pytest.mark.asyncio
async def test_prepare_reconciles_removed_hook_without_creating_an_empty_root(no_save, records_root):
    fresh = AgenticProcess(
        id=mint_uuid(),
        worker_type=WorkerType.CLAUDE_CODE,
        load_flowpad_assistant=False,
    )
    fresh_root = fresh._process_assets_path()

    prepared_empty = await fresh.prepare_process_assets()

    assert prepared_empty.hook_runtime.plugin_dirs == ()
    assert not fresh_root.exists()

    process = AgenticProcess(
        id=mint_uuid(),
        worker_type=WorkerType.CLAUDE_CODE,
        load_flowpad_assistant=False,
    )
    await process.set_hook(HookEventType.USER_PROMPT_SUBMIT)
    prepared = await process.prepare_process_assets()
    plugin_dir = prepared.hook_runtime.plugin_dirs[0]
    assert process._process_assets_path().exists()
    assert str(process._process_assets_path()) in process.resolved_add_dirs
    assert Path(plugin_dir).exists()

    await process.remove_hook(HookEventType.USER_PROMPT_SUBMIT)
    reconciled = await process.prepare_process_assets()

    assert reconciled.hook_runtime.plugin_dirs == ()
    assert not Path(plugin_dir).exists()
    assert str(process._process_assets_path()) not in process.resolved_add_dirs


@pytest.mark.asyncio
async def test_fileless_codex_hook_does_not_mount_or_create_process_assets(no_save, records_root):
    process = AgenticProcess(
        id=mint_uuid(),
        worker_type=WorkerType.CODEX,
        load_flowpad_assistant=False,
    )
    await process.set_hook(HookEventType.USER_PROMPT_SUBMIT)

    prepared = await process.prepare_process_assets()

    assert prepared.hook_runtime.plugin_dirs == ()
    assert not process._process_assets_path().exists()
    assert str(process._process_assets_path()) not in process.resolved_add_dirs


@pytest.mark.asyncio
async def test_no_feature_serialization_snapshot_and_save_keep_assets_lazy(
    initialize_test_db,
    records_root,
):
    process = AgenticProcess(
        id=mint_uuid(),
        worker_type=WorkerType.CLAUDE_CODE,
        load_flowpad_assistant=False,
    )
    assets_path = process._process_assets_path()
    assert not assets_path.exists()

    first = process.model_dump(mode="json")
    second = process.model_dump(mode="json")

    assert first["assets_folder"] == second["assets_folder"]
    assert first["assets_folder"]["path"] == str(assets_path)
    assert first["assets_folder"]["ref_type"] == "folder"
    assert not assets_path.exists()

    assert process._restart_snapshot_payload() == process._restart_snapshot_payload()
    assert not assets_path.exists()

    await process.save()

    assert not assets_path.exists()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("worker_type", "plugin_relative_path"),
    [
        (WorkerType.CLAUDE_CODE, ".flowpad/plugins/claude/flowpad-process-hooks"),
        (WorkerType.COPILOT, ".flowpad/plugins/copilot/flowpad-process-hooks"),
        (WorkerType.CODEX, None),
    ],
)
async def test_hook_restart_snapshot_is_semantic_and_artifact_independent(
    no_save,
    records_root,
    worker_type,
    plugin_relative_path,
):
    process = AgenticProcess(
        id=mint_uuid(),
        worker_type=worker_type,
        load_flowpad_assistant=False,
    )
    baseline = process._restart_snapshot()
    unsubscribe = process.register_callback(lambda _data: None)
    assert process._restart_snapshot() == baseline

    assert await process.set_hook(HookEventType.USER_PROMPT_SUBMIT) is True
    configured = process._restart_snapshot()
    assert configured != baseline
    assert await process.set_hook(HookEventType.USER_PROMPT_SUBMIT) is False
    assert process._restart_snapshot() == configured

    prepared = await process.prepare_process_assets()
    assert process._restart_snapshot() == configured
    if plugin_relative_path is None:
        assert prepared.hook_runtime.plugin_dirs == ()
        assert not process._process_assets_path().exists()
    else:
        plugin_dir = Path(prepared.hook_runtime.plugin_dirs[0])
        process.ensure_process_assets().remove(plugin_relative_path)
        assert not plugin_dir.exists()
    assert process._restart_snapshot() == configured
    await process.prepare_process_assets()
    assert process._restart_snapshot() == configured

    assert await process.remove_hook(HookEventType.USER_PROMPT_SUBMIT) is True
    assert process._restart_snapshot() == baseline
    unsubscribe()


def test_legacy_internal_asset_mount_is_filtered_without_touching_similar_user_dir(records_root):
    process_id = mint_uuid()
    seed = AgenticProcess(id=process_id, load_flowpad_assistant=False)
    canonical = str(seed._process_assets_path())
    similar_user_dir = f"{canonical}-user"

    process = AgenticProcess(
        id=process_id,
        load_flowpad_assistant=False,
        additional_dirs=[canonical, similar_user_dir],
    )

    assert process.additional_dirs == [similar_user_dir]
    assert process.model_dump(mode="json")["additional_dirs"] == [similar_user_dir]


@pytest.mark.asyncio
async def test_hook_intent_persists_and_rehydrated_process_reaches_registered_callback(
    initialize_test_db,
    monkeypatch,
):
    process = AgenticProcess(
        id=mint_uuid(),
        worker_type=WorkerType.CLAUDE_CODE,
        load_flowpad_assistant=False,
    )
    await process.save()
    received: list[AgentHookData] = []
    process.register_callback(received.append)

    assert await process.set_hook(HookEventType.USER_PROMPT_SUBMIT) is True
    rehydrated = await AgenticProcess.get_by_id(process.id)
    assert rehydrated is not None
    assert rehydrated is not process
    assert rehydrated.process_hook_events == [HookEventType.USER_PROMPT_SUBMIT.value]

    async def capture(_self, _flow_data):
        return None

    monkeypatch.setattr(AgenticProcess, "emit_flow_data", capture)
    data = AgentHookData(
        agentic_process_id=process.id,
        hook_data={"hook_event_name": "UserPromptSubmit", "prompt": "persisted delivery"},
    )
    await rehydrated.on_hook(data)

    assert received == [data]
    await process.delete()


@pytest.mark.asyncio
async def test_callback_delivery_uses_process_id_and_one_targeted_flowdata(monkeypatch):
    process_id = mint_uuid()
    registered = AgenticProcess(id=process_id, process_hook_events=["UserPromptSubmit"])
    delivered = AgenticProcess(id=process_id, process_hook_events=["UserPromptSubmit"])
    order: list[str] = []
    emitted: list[dict] = []

    registered.register_callback(lambda _data: order.append("sync"))

    async def async_callback(_data):
        order.append("async")

    unsubscribe = registered.register_callback(async_callback)

    async def capture(_self, flow_data):
        emitted.append(flow_data)

    monkeypatch.setattr(AgenticProcess, "emit_flow_data", capture)
    data = AgentHookData(
        agentic_process_id=process_id,
        hook_data={"hook_event_name": "UserPromptSubmit", "prompt": "line one\nline two"},
    )

    await delivered.on_hook(data)
    unsubscribe()
    unsubscribe()

    assert order == ["sync", "async"]
    assert len(emitted) == 1
    assert emitted[0]["attributes"]["kind"] == "process_hook"
    assert emitted[0]["flow_value"] == data.model_dump(mode="python")


@pytest.mark.asyncio
async def test_callback_snapshot_and_failure_isolation():
    process_id = mint_uuid()
    process = AgenticProcess(id=process_id)
    seen: list[str] = []

    def no_unsubscribe() -> None:
        return None

    unsubscribe_second = [no_unsubscribe]

    def first(_data):
        seen.append("first")
        unsubscribe_second[0]()
        raise RuntimeError("isolated")

    process.register_callback(first)
    unsubscribe_second[0] = process.register_callback(lambda _data: seen.append("second"))
    data = AgentHookData(agentic_process_id=process_id, hook_data={"hook_event_name": "UserPromptSubmit"})

    await dispatch_process_hook(process_id, data)
    await dispatch_process_hook(process_id, data)

    assert seen == ["first", "second", "first"]


@pytest.mark.asyncio
async def test_delete_clears_callbacks_only_after_entity_delete_succeeds(monkeypatch):
    deleted = AgenticProcess(id=mint_uuid())
    failed = AgenticProcess(id=mint_uuid())
    seen: list[str] = []
    deleted.register_callback(lambda _data: seen.append("deleted"))
    unsubscribe_failed = failed.register_callback(lambda _data: seen.append("failed"))

    async def successful_delete(_self):
        return None

    monkeypatch.setattr(Entity, "delete", successful_delete)
    await deleted.delete()

    async def failed_delete(_self):
        raise RuntimeError("delete failed")

    monkeypatch.setattr(Entity, "delete", failed_delete)
    with pytest.raises(RuntimeError, match="delete failed"):
        await failed.delete()

    await dispatch_process_hook(
        deleted.id,
        AgentHookData(agentic_process_id=deleted.id, hook_data={"hook_event_name": "UserPromptSubmit"}),
    )
    await dispatch_process_hook(
        failed.id,
        AgentHookData(agentic_process_id=failed.id, hook_data={"hook_event_name": "UserPromptSubmit"}),
    )
    unsubscribe_failed()

    assert seen == ["failed"]


@pytest.mark.asyncio
async def test_direct_listen_route_unwraps_vendor_native_hook_data(monkeypatch):
    process_id = mint_uuid()
    process = AgenticProcess(
        id=process_id,
        worker_type=WorkerType.CLAUDE_CODE,
        process_hook_events=["UserPromptSubmit"],
    )
    normalized_inputs: list[dict] = []
    delivered: list[AgentHookData] = []

    class Driver:
        def normalize_process_hook_data(self, target_id, raw_hook_data):
            normalized_inputs.append(raw_hook_data)
            return AgentHookData(
                agentic_process_id=target_id,
                hook_data={"hook_event_name": "UserPromptSubmit", "raw_hook_data": raw_hook_data},
            )

    process.__dict__["driver"] = Driver()

    async def get_by_id(_cls, target_id):
        assert target_id == process_id
        return process

    async def on_hook(_self, data):
        delivered.append(data)

    monkeypatch.setattr(AgenticProcess, "get_by_id", classmethod(get_by_id))
    monkeypatch.setattr(AgenticProcess, "on_hook", on_hook)
    native = {"hook_event_name": "UserPromptSubmit", "prompt": "hello\nworld"}

    response = await handle_process_agent_hook(
        AgentHookData(
            agentic_process_id=process_id,
            hook_data={"hook_event_name": "UserPromptSubmit", "raw_hook_data": native},
        )
    )

    assert response.data == {"received": True}
    assert normalized_inputs == [native]
    assert delivered[0].hook_data["raw_hook_data"] == native


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("worker_type", "driver_cls", "driver_module", "runtime_kind"),
    [
        (WorkerType.CLAUDE_CODE, ClaudeDriver, claude_driver_module, "plugin"),
        (WorkerType.COPILOT, CopilotDriver, copilot_driver_module, "plugin"),
        (WorkerType.CODEX, CodexDriver, codex_driver_module, "config"),
    ],
)
async def test_each_worker_launch_entry_prepares_once_with_runtime_parity(
    monkeypatch,
    tmp_path,
    worker_type,
    driver_cls,
    driver_module,
    runtime_kind,
):
    plugin_dir = str(tmp_path / "process plugin")
    config_overrides = (("features.hooks", True),)
    prepared = PreparedProcessAssets(
        hook_runtime=(
            ProcessHookRuntime(plugin_dirs=(plugin_dir,))
            if runtime_kind == "plugin"
            else ProcessHookRuntime(
                config_overrides=config_overrides,
                bypass_hook_trust=True,
            )
        ),
    )
    prepare_calls: dict[str, int] = {}
    contexts: dict[str, object] = {}
    completed: dict[str, asyncio.Event] = {}

    async def prepare(self):
        prepare_calls[self.id] = prepare_calls.get(self.id, 0) + 1
        return prepared

    async def no_op(_self, *_args, **_kwargs):
        return None

    async def end_turn(self, _source):
        completed[self.id].set()

    monkeypatch.setattr(AgenticProcess, "prepare_process_assets", prepare)
    monkeypatch.setattr(AgenticProcess, "get_project", no_op)
    monkeypatch.setattr(AgenticProcess, "save", no_op)
    monkeypatch.setattr(AgenticProcess, "notify_updated", no_op)
    monkeypatch.setattr(AgenticProcess, "end_headless_turn", end_turn)
    monkeypatch.setattr(AgenticProcess, "reap_if_orphaned", no_op)
    monkeypatch.setattr(AgenticProcess, "_await_capability_discovery", no_op)

    async def no_auth(_options, _process):
        return None

    from flow_sdk.builtin.agentic_process.cli_drivers import api_auth

    monkeypatch.setattr(api_auth, "apply_api_model_to_options", no_auth)
    monkeypatch.setattr(agentic_process_module, "apply_worker_secret_env", no_auth)
    monkeypatch.setattr(driver_module, "apply_worker_secret_env", no_auth)

    class Worker:
        def __init__(self, key: str) -> None:
            self.key = key
            self.transcript_path = None

        async def execute(self, *, prompt, context):
            assert prompt
            contexts[self.key] = context
            if False:
                yield None

        def get_session_id(self):
            return None

    pty = AgenticProcess(
        id=mint_uuid(),
        worker_type=worker_type,
        workdir=str(tmp_path),
        process_hook_events=["UserPromptSubmit"],
        load_flowpad_assistant=False,
    )
    pty_argv: list[str] = []

    class Shell:
        id = mint_uuid()
        pty_pid = "pty"
        worker_pid = 123
        compute_node = None

        async def start_pty(self, *, on_exit, spawn_args, extra_env):
            assert on_exit
            assert extra_env is not None
            pty_argv.extend(spawn_args)
            return False

        async def worker_alive(self):
            return True

        def model_dump(self, *, mode):
            assert mode == "json"
            return {"id": self.id}

    shell = Shell()

    async def get_shell(_self):
        return shell

    monkeypatch.setattr(AgenticProcess, "_get_or_create_shell", get_shell)
    monkeypatch.setattr(cli_worker_base_driver, "worker_path_env", lambda _worker: {"PATH": "/bin"})
    monkeypatch.setattr(cli_worker_base_driver, "worker_bin_folder", lambda _worker: None)

    await pty._perform_open("hello", visible=True)

    http = AgenticProcess(
        id=mint_uuid(),
        worker_type=worker_type,
        workdir=str(tmp_path),
        pty_mode=False,
        process_hook_events=["UserPromptSubmit"],
        load_flowpad_assistant=False,
    )
    direct = AgenticProcess(
        id=mint_uuid(),
        worker_type=worker_type,
        workdir=str(tmp_path),
        pty_mode=False,
        process_hook_events=["UserPromptSubmit"],
        load_flowpad_assistant=False,
    )
    completed[http.id] = asyncio.Event()
    completed[direct.id] = asyncio.Event()

    class RequestInfo:
        async def get_post_data(self):
            return {"message": "hello"}

    monkeypatch.setattr(agentic_process_module, "get_current_request_info", lambda: RequestInfo())
    monkeypatch.setattr(driver_cls, "stream_worker", lambda _driver, process: Worker(process.id))
    if worker_type is WorkerType.CLAUDE_CODE:
        monkeypatch.setattr(driver_module, "ClaudeCLIStreamWorker", lambda: Worker(direct.id))
    elif worker_type is WorkerType.CODEX:
        monkeypatch.setattr(
            driver_module,
            "CodexCLIStreamWorker",
            type("DirectWorker", (), {"for_process": classmethod(lambda _cls, _id: Worker(direct.id))}),
        )
    else:
        monkeypatch.setattr(
            driver_module,
            "CopilotCLIStreamWorker",
            type("DirectWorker", (), {"for_process": classmethod(lambda _cls, _id: Worker(direct.id))}),
        )

    await http._http_prompt()
    await completed[http.id].wait()
    await direct.prompt("hello")
    await completed[direct.id].wait()

    def plugin_flags(argv):
        return [argv[index + 1] for index, value in enumerate(argv[:-1]) if value == "--plugin-dir"]

    assert prepare_calls == {pty.id: 1, http.id: 1, direct.id: 1}
    if runtime_kind == "plugin":
        assert plugin_flags(pty_argv) == [plugin_dir]
        assert contexts[http.id].plugin_dirs == [plugin_dir]
        assert contexts[direct.id].plugin_dirs == [plugin_dir]
    else:
        assert pty_argv.count("--dangerously-bypass-hook-trust") == 1
        assert any(value.startswith("features.hooks=") for value in pty_argv)
        assert contexts[http.id].extra_config_overrides == list(config_overrides)
        assert contexts[direct.id].extra_config_overrides == list(config_overrides)
        assert contexts[http.id].bypass_hook_trust is True
        assert contexts[direct.id].bypass_hook_trust is True


SESSION_EVENTS = [HookEventType.SESSION_START, HookEventType.SESSION_END]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "worker_type",
    [WorkerType.CLAUDE_CODE, WorkerType.CODEX, WorkerType.COPILOT],
)
async def test_hook_events_accumulate_in_canonical_order_and_remove_independently(no_save, worker_type):
    process = AgenticProcess(id=mint_uuid(), worker_type=worker_type)

    for event in (HookEventType.USER_PROMPT_SUBMIT, *SESSION_EVENTS):
        assert await process.set_hook(event) is True

    assert process.process_hook_events == ["SessionEnd", "SessionStart", "UserPromptSubmit"]

    assert await process.remove_hook(HookEventType.SESSION_START) is True
    assert process.process_hook_events == ["SessionEnd", "UserPromptSubmit"]
    assert await process.remove_hook(HookEventType.SESSION_START) is False


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("worker_type", "plugin_relative_path"),
    [
        (WorkerType.CLAUDE_CODE, ".flowpad/plugins/claude/flowpad-process-hooks"),
        (WorkerType.COPILOT, ".flowpad/plugins/copilot/flowpad-process-hooks"),
        (WorkerType.CODEX, None),
    ],
)
async def test_each_session_event_moves_the_restart_snapshot_independently(
    no_save,
    records_root,
    worker_type,
    plugin_relative_path,
):
    """Restart identity is per-event and stays artifact-independent."""
    process = AgenticProcess(
        id=mint_uuid(),
        worker_type=worker_type,
        load_flowpad_assistant=False,
    )
    baseline = process._restart_snapshot()

    assert await process.set_hook(HookEventType.SESSION_START) is True
    start_only = process._restart_snapshot()
    assert start_only != baseline

    assert await process.set_hook(HookEventType.SESSION_END) is True
    both = process._restart_snapshot()
    assert both not in (baseline, start_only)

    prepared = await process.prepare_process_assets()
    assert process._restart_snapshot() == both
    if plugin_relative_path is None:
        assert prepared.hook_runtime.plugin_dirs == ()
    else:
        assert Path(prepared.hook_runtime.plugin_dirs[0]).exists()
    await process.prepare_process_assets()
    assert process._restart_snapshot() == both

    assert await process.remove_hook(HookEventType.SESSION_END) is True
    assert process._restart_snapshot() == start_only
    assert await process.remove_hook(HookEventType.SESSION_START) is True
    assert process._restart_snapshot() == baseline


@pytest.mark.asyncio
async def test_on_hook_delivers_each_configured_session_event_with_its_own_subtype(monkeypatch):
    process_id = mint_uuid()
    process = AgenticProcess(id=process_id, process_hook_events=["SessionEnd", "SessionStart"])
    received: list[AgentHookData] = []
    emitted: list[dict] = []
    process.register_callback(received.append)

    async def capture(_self, flow_data):
        emitted.append(flow_data)

    monkeypatch.setattr(AgenticProcess, "emit_flow_data", capture)
    start = AgentHookData(
        agentic_process_id=process_id,
        hook_data={"hook_event_name": "SessionStart", "source": "startup", "session_id": "s1"},
    )
    end = AgentHookData(
        agentic_process_id=process_id,
        hook_data={"hook_event_name": "SessionEnd", "reason": "other", "session_id": "s1"},
    )

    await process.on_hook(start)
    await process.on_hook(end)

    assert received == [start, end]
    assert [item["attributes"]["subtype"] for item in emitted] == ["SessionStart", "SessionEnd"]
    assert {item["attributes"]["kind"] for item in emitted} == {"process_hook"}


@pytest.mark.asyncio
async def test_on_hook_rejects_an_event_this_process_has_not_configured():
    """A live worker may still project a hook the entity no longer lists."""
    process_id = mint_uuid()
    process = AgenticProcess(id=process_id, process_hook_events=["SessionStart"])
    seen: list[AgentHookData] = []
    process.register_callback(seen.append)

    with pytest.raises(ValueError, match="process hook event is not configured: SessionEnd"):
        await process.on_hook(
            AgentHookData(
                agentic_process_id=process_id,
                hook_data={"hook_event_name": "SessionEnd", "reason": "other"},
            )
        )

    assert seen == []
