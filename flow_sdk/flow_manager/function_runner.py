"""FlowFunction subprocess runner — executes a function node in ISOLATION.

The one flow-function contract (identical for inline and subprocess runtimes):

    def on_flow_event(event_name: str, data: dict, flow_ctx) -> dict | None:
        ...
        flow_ctx.emit_flow_event("summary", {"count": 3})
        return {"ok": True}   # a non-None dict auto-emits the node's `done`

The function reference is either a flow-folder script (``scripts/<file>.py``)
or a ``flow_functions`` registry name (the subprocess imports flow_sdk and
resolves it — promoting a library function to isolation is a config change).

``flow_ctx`` provides: ``emit_flow_event(key, val)``, ``post(path, body)``,
``log(msg)`` (stdout — captured), ``flow_id`` / ``node_id`` / ``execution_id``,
and the standardized I/O record folders: ``input_folder`` / ``output_folder``
(THIS execution's record) + ``flow_output_folder`` (the run's ``output/``).

Isolation: runs via ``python -m flow_sdk.flow_manager.function_runner`` in its
own process, never inside the server. stdout/stderr are captured in full to
the execution record; a non-zero exit fails the node with the stderr tail as
the reason. The subprocess is killed if the run's deadline budget expires.
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
from typing import TYPE_CHECKING, Any, Optional

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.flow_manager.envelope import RunEvent
    from flow_sdk.flow_manager.flow_doc import FlowNodeDef
    from flow_sdk.flow_manager.manager import _Run

logger = logging.getLogger(__name__)

RESULT_MARKER = "__FLOW_FUNCTION_RESULT__:"


def record_emission(output_folder: "Path | None", event: str, data: dict) -> None:
    """Append one emission to the execution record's ``emitted.jsonl`` — part of
    the standardized output slot (what this execution produced), shared by the
    inline and subprocess runtimes."""
    if output_folder is None:
        return
    try:
        with (Path(output_folder) / "emitted.jsonl").open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({"event": event, "data": data}, default=str) + "\n")
    except OSError:
        pass


@dataclass
class FunctionResult:
    exit_code: int
    stdout: str
    stderr: str
    result: Optional[dict] = None  # the handler's dict return (auto-`done` payload)


def _api_base() -> str:
    """This instance's HTTP base (for the subprocess's emit bridge)."""
    from flow_sdk.config import load_server_info

    return f"http://localhost:{load_server_info().get('port', 9007)}"


async def run_function_subprocess(
    flow_folder: Path,
    node: "FlowNodeDef",
    fe: "RunEvent",
    run: "_Run",
    folders: dict[str, str],
) -> FunctionResult:
    """Manager-side harness: spawn the runner subprocess for one event.

    ``folders`` carries the execution-record paths threaded into flow_ctx:
    ``{"input": ..., "output": ..., "flow_output": ...}``.
    """
    ref = str(node.node_data.get("function") or "")
    target = ref
    if ref.endswith(".py"):
        script = (flow_folder / ref).resolve()
        if not script.exists():
            return FunctionResult(exit_code=127, stdout="", stderr=f"script not found: {ref}")
        target = str(script)
    elif not ref:
        return FunctionResult(exit_code=127, stdout="", stderr="function node has no function ref")

    payload = json.dumps({
        "event": fe.event,
        "data": fe.data,
        "ctx": {
            "flow_id": fe.flow_id,
            "node_id": node.id,
            "execution_id": fe.execution_id,
            "api_base": _api_base(),
            "folders": folders,
        },
    })
    env = dict(os.environ)
    env.setdefault("FLOW_INSTANCE", os.environ.get("FLOW_INSTANCE", ""))
    proc = await asyncio.create_subprocess_exec(
        sys.executable, "-m", "flow_sdk.flow_manager.function_runner", target,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
        cwd=str(flow_folder),
    )
    # Bound by the run's remaining deadline budget (a designed loop budget,
    # not a symptom mask): a hung function must not hold the node slot forever.
    remaining = max(1.0, run.flow.doc.config.deadline_s - (time.monotonic() - run.started_at))
    try:
        out, err = await asyncio.wait_for(proc.communicate(payload.encode()), timeout=remaining)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return FunctionResult(exit_code=124, stdout="", stderr="killed: run deadline budget expired")

    stdout = out.decode(errors="replace")
    stderr = err.decode(errors="replace")
    # The handler's return rides back on a marker line (stdout stays the
    # function's log channel; the marker line is stripped from it).
    result: Optional[dict] = None
    kept: list[str] = []
    for line in stdout.splitlines():
        if line.startswith(RESULT_MARKER):
            try:
                parsed = json.loads(line[len(RESULT_MARKER):])
                if isinstance(parsed, dict):
                    result = parsed
            except ValueError:
                pass
        else:
            kept.append(line)
    return FunctionResult(
        exit_code=proc.returncode or 0,
        stdout="\n".join(kept) + ("\n" if kept else ""),
        stderr=stderr,
        result=result,
    )


# ── subprocess side (python -m flow_sdk.flow_manager.function_runner <ref>) ──


class FlowCtx:
    """What ``on_flow_event`` receives as ``flow_ctx`` (subprocess runtime)."""

    def __init__(self, flow_id: str, node_id: str, execution_id: str, api_base: str,
                 folders: dict[str, str] | None = None) -> None:
        self.flow_id = flow_id
        self.node_id = node_id
        self.execution_id = execution_id
        self._api_base = api_base
        folders = folders or {}
        self.input_folder = Path(folders["input"]) if folders.get("input") else None
        self.output_folder = Path(folders["output"]) if folders.get("output") else None
        self.flow_output_folder = Path(folders["flow_output"]) if folders.get("flow_output") else None

    def post(self, path: str, body: dict, *, timeout: int = 60) -> dict:
        """POST to this instance's REST API — the sanctioned subprocess→backend
        channel (a subprocess must never open the instance DB directly).
        ``path`` is rooted at the API base (e.g. ``/api/v1/graph/usage_report``).
        Returns the response envelope's ``data`` (or the raw JSON body)."""
        import urllib.request

        req = urllib.request.Request(
            f"{self._api_base}{path}",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read() or "{}")
        return payload.get("data") if isinstance(payload, dict) and "data" in payload else payload

    def emit_flow_event(self, key: str, val: Any = None) -> None:
        """Emit an event from THIS node into the current run."""
        data = val if isinstance(val, dict) else {"value": val}
        record_emission(self.output_folder, key, data)
        self.post(
            f"/api/v1/agentic-flows/{self.flow_id}/inject",
            {
                "event": key,
                "data": data,
                "execution_id": self.execution_id,
                "source_node": self.node_id,
            },
            timeout=30,
        )

    @staticmethod
    def log(msg: Any) -> None:
        print(msg, flush=True)


def _resolve_handler(target: str):
    """Script path → import the file; anything else → flow_functions registry."""
    if target.endswith(".py"):
        import importlib.util

        spec = importlib.util.spec_from_file_location("flow_script", Path(target).resolve())
        if spec is None or spec.loader is None:
            print(f"cannot load script: {target}", file=sys.stderr)
            return None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        handler = getattr(module, "on_flow_event", None)
        if not callable(handler):
            print("script defines no on_flow_event(event_name, data, flow_ctx)", file=sys.stderr)
            return None
        return handler
    from flow_sdk.flow_manager import flow_functions
    from flow_sdk.flow_manager import demo_callbacks  # noqa: F401 — registration side effect
    from flow_sdk.usage_report import callback as _usage_cb  # noqa: F401 — registration side effect

    handler = flow_functions.get(target)
    if handler is None:
        print(f"no registered FlowFunction {target!r}", file=sys.stderr)
        return None
    return handler


def _main() -> int:
    if len(sys.argv) != 2:
        print("usage: python -m flow_sdk.flow_manager.function_runner <script.py | registry-name>",
              file=sys.stderr)
        return 64
    payload = json.loads(sys.stdin.read() or "{}")
    ctx_raw = payload.get("ctx") or {}
    ctx = FlowCtx(
        flow_id=str(ctx_raw.get("flow_id") or ""),
        node_id=str(ctx_raw.get("node_id") or ""),
        execution_id=str(ctx_raw.get("execution_id") or ""),
        api_base=str(ctx_raw.get("api_base") or "http://localhost:9007"),
        folders=ctx_raw.get("folders") or {},
    )
    handler = _resolve_handler(sys.argv[1])
    if handler is None:
        return 65
    result = handler(str(payload.get("event") or ""), payload.get("data") or {}, ctx)
    if asyncio.iscoroutine(result):
        result = asyncio.get_event_loop().run_until_complete(result)
    if isinstance(result, dict):
        # Marker line carries the auto-`done` payload back to the manager.
        print(RESULT_MARKER + json.dumps(result, default=str), flush=True)
    return 0


if __name__ == "__main__":  # pragma: no cover — exercised via subprocess in tests
    sys.exit(_main())
