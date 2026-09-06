"""Deleting a project must remove the chat history that project discovery reads."""

import asyncio
import os
import shutil
from contextlib import aclosing
from pathlib import Path
from time import perf_counter

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.agentic_process import prompt_worker_active
from flow_sdk.builtin.agentic_process.cli_drivers.opencode.session_history import find_opencode_session
from flow_sdk.builtin.project import Project
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.flowpad_types.vendors import VENDORS
from flow_sdk.fs_store import FSRef, RecordType
from flow_sdk.fs_store.indexer import IndexerOptions, build_default_indexer
from flow_sdk.fs_store.indexer.functions.claude_projects import claude_project_identity_key
from flow_sdk.fs_store.operations.project_cleanup import HarnessIndex, clear_harness_state
from flow_sdk.instance_settings import reset_instance_settings
from tests.long_tests._model_tier import small_model_for
from tests.long_tests._transcript_helpers import assert_prompt_ok
from tests.test_settings import test_service_config

pytestmark = [
    pytest.mark.asyncio,
    pytest.mark.skipif(not test_service_config.deep_testing, reason="Requires DEEP_TESTING and real worker CLIs"),
]


async def _start_hi(process):
    started = perf_counter()
    assert_prompt_ok(await process.prompt("hi"))
    accepted = perf_counter()
    # OpenCode writes a synthetic prompt before spawning; wait for its session too.
    async with aclosing(process.stream_transcript()) as entries:
        async for event in entries:
            assert event.get("type") not in {"error", "flowpad.interrupted"}, event
            if process.session_id:
                print(
                    f"{process.driver.name}: model={process.cli_options.resolved_model}, "
                    f"start_event={event.get('type')}, prompt={accepted - started:.3f}s, "
                    f"session_ready={perf_counter() - started:.3f}s"
                )
                return
    pytest.fail(f"{process.worker_type} ended before establishing a session")


async def test_deleted_project_chats_do_not_reappear_in_project_scan(initialize_test_db, tmp_path, monkeypatch):
    started = perf_counter()
    timings = [("start", started)]
    missing = [v.key for v in VENDORS if shutil.which(v.key) is None]
    if missing:
        pytest.skip(f"Missing worker CLIs: {missing}")
    # The CLI-auth fixture restores HOME; point discovery at those SAME stores.
    real_home = Path(os.environ["FLOWPAD_PRE_SANDBOX_HOME"])
    monkeypatch.setenv("FLOW_HOME", str(tmp_path / "flow-home"))
    monkeypatch.setenv("FLOWPAD_TEST_SANDBOX", str(tmp_path / "runtime"))
    monkeypatch.setenv("FLOW_INSTANCE", "test")
    for env, directory in (("FLOWPAD_CLAUDE_HOME", ".claude"), ("CODEX_HOME", ".codex"),
                           ("FLOWPAD_COPILOT_HOME", ".copilot")):
        monkeypatch.setenv(env, str(real_home / directory))
    reset_instance_settings()
    project = await Project(name="delete-chats", fs_storage_mount_path=str(tmp_path / "project")).save()
    cwd = project.fs_storage_mount_path
    processes = []
    starts = []
    harness_index = None
    try:
        for vendor in VENDORS:
            model = small_model_for(vendor.worker_type)
            # Native Copilot's portable sm means auto; explicitly select a small model here.
            if vendor.worker_type == WorkerType.COPILOT:
                model = "gpt-5.4-mini"
            process = await AgenticProcess(
                worker_type=WorkerType(vendor.worker_type), project_id=project.id, workdir=cwd,
                visible=False, pty_mode=False, load_flowpad_assistant=False,
                cli_config={"model": model},
            ).save()
            assert process.cli_options.model == model and process.cli_options.resolved_model
            processes.append(process)
        timings.append(("create project/processes", perf_counter()))
        starts = [asyncio.create_task(_start_hi(process)) for process in processes]
        await asyncio.gather(*starts)
        timings.append(("concurrent worker startup", perf_counter()))
        indexer = build_default_indexer()
        options = IndexerOptions(types=[RecordType.PROJECT], include_temp=True, verbose=False,
                                 roots=(FSRef(real_home, record_type=RecordType.USER_HOME_FOLDER),))
        before = await indexer.scan(options)
        timings.append(("initial project scan", perf_counter()))
        project_key = claude_project_identity_key(Path(cwd))
        sources = {ref.path for ref in before if ref.record_type == RecordType.PROJECT
                   and claude_project_identity_key(ref) == project_key}
        assert sources, "The real worker chats must be discoverable before deletion"
        timings.append(("match project sources", perf_counter()))
        harness_index = HarnessIndex.build()
        timings.append(("snapshot harness paths for teardown", perf_counter()))
        await project._delete_with_children(delete_chats=True)
        timings.append(("delete project", perf_counter()))
        after = await indexer.scan(options)
        timings.append(("final project scan", perf_counter()))
        rediscovered = sources.intersection(ref.path for ref in after if ref.record_type == RecordType.PROJECT)
        assert not rediscovered, f"Deleted project rediscovered from chat history: {sorted(rediscovered)}"
        assert not any(prompt_worker_active(process.id) for process in processes)
        assert not any(Path(path).exists() for path in harness_index.any_state(cwd))
        assert not any(find_opencode_session(sid) for sid in harness_index.opencode_sessions.get(cwd, []))
    finally:
        print(f"scenario: {perf_counter() - started:.3f}s")
        for task in starts:
            task.cancel()
        await asyncio.gather(*starts, return_exceptions=True)
        await asyncio.gather(*(process._http_cancel_prompt() for process in processes), return_exceptions=True)
        # Only this test's rows/transcripts; never invoke the whole-home cleanup.
        for process in processes:
            await process.delete()
        clear_harness_state({"cwd": cwd}, harness_index or HarnessIndex.build())
        await project.delete()
        reset_instance_settings()
        timings.append(("test cleanup", perf_counter()))
        for (_, previous), (phase, finished) in zip(timings, timings[1:]):
            print(f"{phase}: {finished - previous:.3f}s")
