"""pysdk node runner — executes a flow's python file in a SUBPROCESS.

Contract (the file lives in the flow folder's ``scripts/``):

    def on_flow_event(event_name: str, data: dict, flow_ctx) -> None:
        ...
        flow_ctx.emit_flow_event("summary", {"count": 3})

``flow_ctx`` provides: ``emit_flow_event(key, val)`` (routes as an emission
from THIS node inside the current run), ``flow_id``, ``node_id``,
``execution_id``, and ``log(msg)`` (stdout — captured into the run journal).

Isolation: the script runs via ``python -m flow_sdk.flow_manager.pysdk_runner``
in its own process (full flow_sdk import access, repo venv), never inside the
server. stdout/stderr are captured; a non-zero exit code fails the node with
the stderr tail as the reason. The subprocess is killed if the run's deadline
budget expires while it executes.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.flow_manager.envelope import FlowEvent
    from flow_sdk.flow_manager.flow_doc import FlowNodeDef
    from flow_sdk.flow_manager.manager import _Run

logger = logging.getLogger(__name__)


@dataclass
class PysdkResult:
    exit_code: int
    stdout: str
    stderr: str


def _api_base() -> str:
    """This instance's HTTP base (for the subprocess's emit bridge)."""
    from flow_sdk.config import load_server_info

    return f"http://localhost:{load_server_info().get('port', 9007)}"


async def run_pysdk_node(
    flow_folder: Path, node: "FlowNodeDef", fe: "FlowEvent", run: "_Run"
) -> PysdkResult:
    """Manager-side harness: spawn the runner subprocess for one event."""
    script_rel = str(node.node_data.get("script") or "")
    script = (flow_folder / script_rel).resolve()
    if not script_rel or not script.exists():
        return PysdkResult(exit_code=127, stdout="", stderr=f"script not found: {script_rel}")

    payload = json.dumps({
        "event": fe.event,
        "data": fe.data,
        "ctx": {
            "flow_id": fe.flow_id,
            "node_id": node.id,
            "execution_id": fe.execution_id,
            "api_base": _api_base(),
        },
    })
    env = dict(os.environ)
    env.setdefault("FLOW_INSTANCE", os.environ.get("FLOW_INSTANCE", ""))
    proc = await asyncio.create_subprocess_exec(
        sys.executable, "-m", "flow_sdk.flow_manager.pysdk_runner", str(script),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
        cwd=str(flow_folder),
    )
    # Bound by the run's remaining deadline budget (a designed loop budget,
    # not a symptom mask): a hung script must not hold the node slot forever.
    from flow_sdk.builtin.agentic_flow import DEFAULT_DEADLINE_S

    remaining = max(1.0, DEFAULT_DEADLINE_S - (time.monotonic() - run.started_at))
    try:
        out, err = await asyncio.wait_for(proc.communicate(payload.encode()), timeout=remaining)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return PysdkResult(exit_code=124, stdout="", stderr="killed: run deadline budget expired")
    return PysdkResult(
        exit_code=proc.returncode or 0,
        stdout=out.decode(errors="replace"),
        stderr=err.decode(errors="replace"),
    )


# ── subprocess side (python -m flow_sdk.flow_manager.pysdk_runner <script>) ──


class FlowCtx:
    """What the user's ``on_flow_event`` receives as ``flow_ctx``."""

    def __init__(self, flow_id: str, node_id: str, execution_id: str, api_base: str) -> None:
        self.flow_id = flow_id
        self.node_id = node_id
        self.execution_id = execution_id
        self._api_base = api_base

    def emit_flow_event(self, key: str, val: Any = None) -> None:
        """Emit an event from THIS node into the current run."""
        import urllib.request

        body = json.dumps({
            "event": key,
            "data": val if isinstance(val, dict) else {"value": val},
            "execution_id": self.execution_id,
            "source_node": self.node_id,
        }).encode()
        req = urllib.request.Request(
            f"{self._api_base}/api/v1/agentic-flows/{self.flow_id}/inject",
            data=body, headers={"Content-Type": "application/json"}, method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            resp.read()

    @staticmethod
    def log(msg: Any) -> None:
        print(msg, flush=True)


def _main() -> int:
    if len(sys.argv) != 2:
        print("usage: python -m flow_sdk.flow_manager.pysdk_runner <script.py>", file=sys.stderr)
        return 64
    script = Path(sys.argv[1]).resolve()
    payload = json.loads(sys.stdin.read() or "{}")
    ctx_raw = payload.get("ctx") or {}
    ctx = FlowCtx(
        flow_id=str(ctx_raw.get("flow_id") or ""),
        node_id=str(ctx_raw.get("node_id") or ""),
        execution_id=str(ctx_raw.get("execution_id") or ""),
        api_base=str(ctx_raw.get("api_base") or "http://localhost:9007"),
    )

    import importlib.util

    spec = importlib.util.spec_from_file_location("flow_script", script)
    if spec is None or spec.loader is None:
        print(f"cannot load script: {script}", file=sys.stderr)
        return 66
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    handler = getattr(module, "on_flow_event", None)
    if not callable(handler):
        print("script defines no on_flow_event(event_name, data, flow_ctx)", file=sys.stderr)
        return 65
    handler(str(payload.get("event") or ""), payload.get("data") or {}, ctx)
    return 0


if __name__ == "__main__":  # pragma: no cover — exercised via subprocess in tests
    sys.exit(_main())
