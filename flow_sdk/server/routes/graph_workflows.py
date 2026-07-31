"""GraphWorkflow routes — single owner under ``/api/v1/graph-workflows/*``.

* ``POST /<flow_id>/inject`` — deliver an event into a flow. Body:
  ``{"event", "data"?, "execution_id"?, "source_node"?, "target_node"?}``.
  ``execution_id`` + ``source_node`` is how subprocess functions emit back
  into their run; ``target_node`` delivers directly, bypassing edge routing.
* ``GET  /<flow_id>/runs`` — recent runs (GraphWorkflowRun rows, newest first).
* ``GET  /<flow_id>/runs/<run_id>`` — the run's full journal entries.
* ``POST /<flow_id>/runs/<run_id>/replay`` — re-inject the run's recorded
  ENTRY events into a fresh run (a real re-execution — side effects re-fire).
* ``POST /<flow_id>/reexecute`` ``{"run_id", "seq"}`` — re-deliver one past
  execution's recorded input to its node, in a fresh run.
* ``GET  /functions`` — the GraphWorkflowFunction registry (Function-picker feed).

graph.json / display.json read+write go through the standard asset/FSRef
surface — no bespoke graph REST here.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from fastapi import APIRouter, Request

from flow_sdk.graph_workflow_manager import get_graph_workflow_manager
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

router = APIRouter(prefix="/api/v1/graph-workflows")


@router.get("/functions")
async def functions():
    from flow_sdk.graph_workflow_manager import graph_workflow_functions

    return ApiSuccessResponse(data=graph_workflow_functions.list_registered())


@router.post("/{flow_id}/inject")
async def inject(flow_id: str, request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    event = (body or {}).get("event")
    if not event:
        return ApiFailResponse(message="event is required")
    data = body.get("data") or {}
    if not isinstance(data, dict):
        return ApiFailResponse(message="data must be an object")
    try:
        fe = await get_graph_workflow_manager().inject(
            flow_id,
            str(event),
            data,
            execution_id=body.get("execution_id") or None,
            source_node=body.get("source_node") or "$external",
            target_node=body.get("target_node") or None,
        )
    except ValueError as e:
        return ApiFailResponse(message=str(e))
    return ApiSuccessResponse(data=fe.model_dump(mode="json") if fe else None)


@router.get("/{flow_id}/runs")
async def runs(flow_id: str):
    from flow_sdk.builtin.graph_workflow_run import GraphWorkflowRun

    rows = await GraphWorkflowRun.get_all({"flow_id": flow_id})
    rows.sort(key=lambda r: r.started_at or "", reverse=True)
    return ApiSuccessResponse(data=[
        r.model_dump(mode="json", include={
            "id", "flow_id", "status", "started_at", "ended_at",
            "event_count", "execution_count", "error",
        })
        for r in rows[:50]
    ])


@router.post("/{flow_id}/runs/{run_id}/replay")
async def replay(flow_id: str, run_id: str):
    try:
        new_run_id = await get_graph_workflow_manager().replay_run(flow_id, run_id)
    except ValueError as e:
        return ApiFailResponse(message=str(e))
    return ApiSuccessResponse(data={"run_id": new_run_id})


@router.post("/{flow_id}/reexecute")
async def reexecute(flow_id: str, request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    run_id = str((body or {}).get("run_id") or "")
    seq = (body or {}).get("seq")
    if not run_id or not isinstance(seq, int):
        return ApiFailResponse(message="run_id and integer seq are required")
    try:
        new_run_id = await get_graph_workflow_manager().reexecute(flow_id, run_id, seq)
    except ValueError as e:
        return ApiFailResponse(message=str(e))
    return ApiSuccessResponse(data={"run_id": new_run_id})


@router.get("/{flow_id}/runs/{run_id}")
async def run_journal(flow_id: str, run_id: str):
    from flow_sdk.builtin.graph_workflow import GraphWorkflow
    from flow_sdk.graph_workflow_manager.journal import read_run_journal

    flow = await GraphWorkflow.get_by_id(flow_id)
    if flow is None or not flow.asset_ref:
        return ApiFailResponse(message=f"Unknown flow: {flow_id}")
    return ApiSuccessResponse(data=read_run_journal(Path(flow.asset_ref), run_id))


# ── execution artifacts ──────────────────────────────────────────────────────
#
# The engine has always written standardized I/O records per execution
# (`prepare_execution_io`), and nothing has ever read them back — so a flow's
# actual products (a function's output files, an agent's artifacts) were
# reachable only by knowing the records layout and using a shell.
#
# Note an agent node's artifacts live under the AGENTIC PROCESS's record dir,
# not the run's, so listing the run folder alone would miss exactly the outputs
# people care about most. The journal is what links the two.

#: Never inline a file larger than this — the panel previews, it does not host.
MAX_ARTIFACT_PREVIEW_BYTES = 256 * 1024

#: The two subfolders `prepare_execution_io` materializes per execution.
_DIRECTIONS = ("input", "output")


@dataclass(frozen=True)
class _ArtifactRoot:
    """One execution's record folder. `dir` never crosses the wire."""
    key: str
    label: str
    seq: int
    node: str
    dir: Path
    process_id: str | None = None


def _artifact_roots(flow_asset_ref: str, run_id: str) -> dict[str, _ArtifactRoot]:
    """Enumerate every readable execution folder for a run, keyed.

    This is the ONLY place a path is derived, and the read route resolves its
    key through here rather than accepting a path — so a client can only ever
    reach a folder this listing already offered.
    """
    from flow_sdk.fs_store.record_paths import shadow_dir_for
    from flow_sdk.graph_workflow_manager.journal import read_run_journal
    from flow_sdk.graph_workflow_manager.manager import run_record_dir

    roots: dict[str, _ArtifactRoot] = {}
    base = run_record_dir(run_id)
    if (base / "execution").is_dir():
        roots["run"] = _ArtifactRoot("run", "run", 0, "", base / "execution")

    exec_root = base / "executions"
    if exec_root.is_dir():
        for child in sorted(exec_root.iterdir()):
            if not child.is_dir():
                continue
            seq_str, _, node = child.name.partition("-")
            roots[child.name] = _ArtifactRoot(
                key=child.name,
                label=node or child.name,
                seq=int(seq_str) if seq_str.isdigit() else 0,
                node=node,
                dir=child,
            )

    # Agent executions are the reason this route exists: their artifacts live
    # under the AGENTIC PROCESS's record dir, not the run's, and only the
    # journal links the two.
    seen: set[str] = set()
    for entry in read_run_journal(Path(flow_asset_ref), run_id):
        process_id = entry.get("process_id")
        if not isinstance(process_id, str) or process_id in seen:
            continue
        seen.add(process_id)
        proc_dir = shadow_dir_for("agentic_process", process_id) / "execution"
        if not proc_dir.is_dir():
            continue
        execution = entry.get("execution")
        roots[f"proc:{process_id}"] = _ArtifactRoot(
            key=f"proc:{process_id}",
            label=str(entry.get("node") or "agent"),
            seq=int(execution.get("seq") or 0) if isinstance(execution, dict) else 0,
            node=str(entry.get("node") or ""),
            dir=proc_dir,
            process_id=process_id,
        )
    return roots


def _list_files(folder: Path) -> list[dict]:
    out: list[dict] = []
    for direction in _DIRECTIONS:
        sub = folder / direction
        if not sub.is_dir():
            continue
        for path in sorted(sub.rglob("*")):
            if not path.is_file():
                continue
            try:
                size = path.stat().st_size
            except OSError:
                continue
            out.append({
                "name": str(path.relative_to(sub)),
                "direction": direction,
                "size": size,
                "previewable": size <= MAX_ARTIFACT_PREVIEW_BYTES,
                "path": str(path),
            })
    return out


def _resolve_artifact(root: _ArtifactRoot, name: str) -> Path | None:
    """`(root, name)` → path, without re-walking the tree.

    Containment is checked on the resolved path rather than trusted from the
    listing, so a crafted `name` cannot climb out of the execution folder even
    though every legitimate `name` came from `_list_files`.
    """
    for direction in _DIRECTIONS:
        base = (root.dir / direction).resolve()
        try:
            candidate = (base / name).resolve()
        except OSError:
            continue
        if candidate.is_relative_to(base) and candidate.is_file():
            return candidate
    return None


@router.get("/{flow_id}/runs/{run_id}/artifacts")
async def run_artifacts(flow_id: str, run_id: str):
    """Every execution of this run, with the files it read and wrote."""
    from flow_sdk.builtin.graph_workflow import GraphWorkflow

    flow = await GraphWorkflow.get_by_id(flow_id)
    if flow is None or not flow.asset_ref:
        return ApiFailResponse(message=f"Unknown flow: {flow_id}")

    executions = [
        {
            "key": root.key, "label": root.label, "seq": root.seq,
            "node": root.node, "process_id": root.process_id,
            "files": _list_files(root.dir),
        }
        for root in _artifact_roots(flow.asset_ref, run_id).values()
    ]
    executions.sort(key=lambda e: (e["seq"], e["key"]))
    return ApiSuccessResponse(data={"executions": executions})


@router.get("/{flow_id}/runs/{run_id}/artifact")
async def run_artifact(flow_id: str, run_id: str, key: str, name: str):
    """Read one artifact. ``key`` must come from the listing."""
    from flow_sdk.builtin.graph_workflow import GraphWorkflow

    flow = await GraphWorkflow.get_by_id(flow_id)
    if flow is None or not flow.asset_ref:
        return ApiFailResponse(message=f"Unknown flow: {flow_id}")

    root = _artifact_roots(flow.asset_ref, run_id).get(key)
    if root is None:
        return ApiFailResponse(message=f"Unknown execution: {key}")

    path = _resolve_artifact(root, name)
    if path is None:
        return ApiFailResponse(message=f"No such artifact: {name}")

    size = path.stat().st_size
    if size > MAX_ARTIFACT_PREVIEW_BYTES:
        return ApiFailResponse(message=f"{name} is {size} bytes — too large to preview")
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        return ApiFailResponse(message=f"unreadable: {e}")
    return ApiSuccessResponse(data={
        "name": name, "size": size, "path": str(path), "text": text,
    })
