"""Fork toolbar regression: the real action must retain the parent's provider."""

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.cli_drivers.codex.cli import CodexAgentOptions
from flow_sdk.flowpad_types.enums import WorkerType


async def test_codex_fork_action_preserves_provider(tmp_path):
    parent = AgenticProcess(
        worker_type=WorkerType.CODEX, session_id=mint_uuid(),
        cli_config=CodexAgentOptions().to_json(), workdir=str(tmp_path), pty_mode=True,
    )
    response = await parent.fork_action()
    child = await AgenticProcess.get_by_id(response.data["id"])
    assert child is not None
    # This persisted configuration selected Claude's transcript lookup in the UI failure.
    assert (child.driver.name, child.cli_config["worker_type"]) == (
        parent.driver.name, parent.cli_config["worker_type"],
    )


def test_codex_fork_launches_native_fork_then_resumes_child(tmp_path):
    parent_sid = mint_uuid()
    child = AgenticProcess.fork(parent_sid, worker_type=WorkerType.CODEX,
                                workdir=str(tmp_path), pty_mode=True)
    argv, _ = child.cli_options.to_spawn_args()
    assert argv[-2:] == ["fork", parent_sid]
    assert child.session_id is None
    child.adopt_worker_session(mint_uuid())
    options = child.cli_options
    options.resume = True
    argv, _ = options.to_spawn_args()
    assert argv[-2:] == ["resume", child.session_id]
    assert parent_sid not in argv
