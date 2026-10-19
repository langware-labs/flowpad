"""The graph subprocess context reaches real HTTP through the shared local client."""

import asyncio
import socket
from typing import ClassVar

import pytest
import uvicorn

from flow_sdk.builtin.compute_op import ComputeOp
from flow_sdk.config import save_server_info
from flow_sdk.graph_workflow_manager.function_runner import GraphWorkflowCtx
from flow_sdk.schema.data_spec import DataSpec
from flow_sdk.schema.data_spec.compute_op_spec import PythonOp
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode, PromptResult
from flow_sdk.server.app import app


@pytest.mark.asyncio
async def test_graph_context_http_restores_tagged_input_and_answer_subtype(
    bootstrapped_client, tmp_path, monkeypatch,
):
    monkeypatch.setenv("FLOW_HOME", str(tmp_path / "flow-home"))
    monkeypatch.setenv("FLOW_INSTANCE", "graph-http-test")

    class Row(DataSpec):
        spec_kind: ClassVar[str] = "test.flowcall.graph_http_row"
        number: int

    manifest = tmp_path / "agentic-assets/project_manifest/project_manifest.json"
    manifest.parent.mkdir(parents=True)
    manifest.write_text('{"ns":"graph_transport_fixture"}')
    folder = tmp_path / "agentic-assets/compute_op/graph-http"
    op = ComputeOp(name="graph-http", asset_ref=str(folder), subkind="python",
                   exe_data=PythonOp(), input=[Row.spec_kind], output=[Row.spec_kind])
    await op.save()
    marker = tmp_path / "calls"
    (folder / "call.py").write_text(
        "from pathlib import Path\n"
        "from flow_sdk.schema.data_spec.returned_value_spec import PromptResult\n"
        f"MARKER = Path({str(marker)!r})\n"
        "def call(input, *, context):\n"
        "    assert all(hasattr(row, 'number') for row in input)\n"
        "    MARKER.write_text((MARKER.read_text() if MARKER.exists() else '') + 'x')\n"
        "    return PromptResult.satisfied(value=input, text='full reply', files=['proof.txt'])\n"
    )

    ready = asyncio.Event()

    class ReadyServer(uvicorn.Server):
        async def startup(self, sockets=None):
            await super().startup(sockets=sockets)
            ready.set()

    # The API fixture already bootstrapped this app/DB. Only the HTTP listener is new.
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
        server_file = save_server_info({"port": port})
        assert server_file == tmp_path / "flow-home/instances/graph-http-test/server.json"
        server = ReadyServer(uvicorn.Config(app, lifespan="off", log_level="warning"))
        serving = asyncio.create_task(server.serve(sockets=[listener]))
        readiness = asyncio.create_task(ready.wait())
        try:
            done, _ = await asyncio.wait((serving, readiness), return_when=asyncio.FIRST_COMPLETED)
            if serving in done:
                await serving
                pytest.fail("HTTP listener stopped before becoming ready")
            context = GraphWorkflowCtx("flow", "node", "execution", f"http://127.0.0.1:{port}")
            refused = await context.call(str(op.typeid), input=[Row(number=7)])
            assert refused.exit_code is ExitCode.REFUSED and not marker.exists()

            answer = await context.call(str(op.typeid), input=[Row(number=7)], approved=True)
            assert isinstance(answer, PromptResult)
            assert answer.text == "full reply" and answer.files == ["proof.txt"]
            assert answer.has_value and answer.value == [Row(number=7)]
            assert isinstance(answer.value[0], Row)
            chained = await context.call(str(op.typeid), input=answer.value, approved=True)
            assert isinstance(chained, PromptResult) and chained.value == answer.value
            assert marker.read_text() == "xx"
        finally:
            readiness.cancel()
            await asyncio.gather(readiness, return_exceptions=True)
            server.should_exit = True
            await serving
