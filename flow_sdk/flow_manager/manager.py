"""FlowManager v2 — runs AgenticFlow documents.

Model: an AgenticFlow is a folder document (``graph.json``); events are LOCAL
to their flow; edges ``{from: {node, event}, to: {node}}`` are the only
routing (``"*"`` = catch-all). A run (execution_id) starts on trigger fire or
injection and sinks when no deliveries are pending and no executions are
active. Everything a run does is journaled to ``runs/<run-id>.jsonl`` and
mirrored over WS.

Node execution:
* ``process_runner`` — callback (inline) or spawned agent; spawned agents
  AUTO-EMIT ``done {output}`` when their turn completes.
* ``pysdk`` — subprocess running the flow's script with
  ``on_flow_event(event_name, data, flow_ctx)``; stdio captured, exit code
  managed (see pysdk_runner.py).
* ``trigger`` — never executes; emits ``fired`` when its Trigger entity fires.

The per-node scheduler (serial/parallel, queue, merge_identical) is keyed by
(flow, node). Loop budgets (hops, processes, deadline) are enforced per run.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from flow_sdk.builtin.agentic_flow import (
    DEFAULT_DEADLINE_S,
    DEFAULT_MAX_HOPS,
    DEFAULT_MAX_PROCESSES,
    AgenticFlow,
)
from flow_sdk.core.capabilities.models import now_iso
from flow_sdk.flow_manager.envelope import EXTERNAL_SOURCE, FlowEvent
from flow_sdk.flow_manager.flow_doc import (
    AGENT_DONE_EVENT,
    TRIGGER_FIRED_EVENT,
    FlowDoc,
    FlowNodeDef,
    parse_flow_doc,
)
from flow_sdk.flow_manager.journal import RunJournal

logger = logging.getLogger(__name__)

_SPAWN_WATCH_INTERVAL_S = 2.0


class _LoadedFlow:
    """A flow's document + folder, cached with mtime validation (disk is truth)."""

    __slots__ = ("flow_id", "folder", "doc", "mtime", "enabled")

    def __init__(self, flow_id: str, folder: Path, doc: FlowDoc, mtime: float) -> None:
        self.flow_id = flow_id
        self.folder = folder
        self.doc = doc
        self.mtime = mtime
        self.enabled = doc.enabled


class _Run:
    """Live run state: counters + journal. Row upserts happen at start/end."""

    __slots__ = ("id", "flow", "journal", "started_at", "pending", "active",
                 "hops", "processes", "events", "executions", "error", "finalized")

    def __init__(self, run_id: str, flow: _LoadedFlow) -> None:
        self.id = run_id
        self.flow = flow
        self.journal = RunJournal(flow.folder, run_id)
        self.started_at = time.monotonic()
        self.pending = 0      # deliveries enqueued, not yet started
        self.active = 0       # executions in flight
        self.hops = 0
        self.processes = 0
        self.events = 0
        self.executions = 0
        self.error: Optional[str] = None
        self.finalized = False

    @property
    def deadline_exceeded(self) -> bool:
        return time.monotonic() - self.started_at > DEFAULT_DEADLINE_S

    def maybe_sink(self) -> bool:
        return not self.finalized and self.pending == 0 and self.active == 0


class _NodeRuntime:
    """Per-(flow,node) scheduler state: pending deliveries + in-flight count."""

    __slots__ = ("queue", "active")

    def __init__(self) -> None:
        from collections import deque

        self.queue: "deque[tuple[FlowEvent, FlowNodeDef, _Run]]" = deque()
        self.active = 0


def _delivery_identity(event: FlowEvent) -> str:
    return f"{event.event}|{json.dumps(event.data, sort_keys=True, default=str)}"


class FlowManager:
    def __init__(self) -> None:
        self._flows: dict[str, _LoadedFlow] = {}
        self._runs: dict[str, _Run] = {}
        self._runtime: dict[tuple[str, str], _NodeRuntime] = {}

    # ── flow loading (disk is truth; mtime-validated cache) ───────────────────

    async def load_flow(self, flow_id: str, entity: AgenticFlow | None = None) -> Optional[_LoadedFlow]:
        if entity is None:
            entity = await AgenticFlow.get_by_id(flow_id)
        if entity is None or not entity.asset_ref:
            return None
        folder = Path(entity.asset_ref)
        graph = folder / "graph.json"
        try:
            mtime = graph.stat().st_mtime
        except OSError:
            return None
        cached = self._flows.get(flow_id)
        if cached is not None and cached.mtime == mtime:
            return cached
        try:
            doc = parse_flow_doc(graph.read_text(encoding="utf-8"))
        except ValueError as e:
            logger.warning("FlowManager: bad graph.json for %s: %s", flow_id, e)
            return None
        loaded = _LoadedFlow(flow_id, folder, doc, mtime)
        # The entity's enabled switch wins when it and the doc disagree.
        loaded.enabled = bool(entity.enabled) and doc.enabled
        self._flows[flow_id] = loaded
        return loaded

    async def flows_referencing_trigger(self, trigger_id: str) -> list[_LoadedFlow]:
        out: list[_LoadedFlow] = []
        for entity in await AgenticFlow.get_all({}):
            loaded = await self.load_flow(entity.id, entity)
            if loaded and loaded.enabled and trigger_id in loaded.doc.trigger_ids():
                out.append(loaded)
        return out

    # ── activation ────────────────────────────────────────────────────────────

    async def on_trigger_fired(self, trigger_id: str) -> list[str]:
        """Trigger fire → start a run in every active flow referencing it.
        Returns started run ids. Called from the trigger fire paths."""
        run_ids: list[str] = []
        for flow in await self.flows_referencing_trigger(trigger_id):
            for node in flow.doc.trigger_nodes_for(trigger_id):
                run = await self._start_run(flow)
                await self._route(run, FlowEvent(
                    event=TRIGGER_FIRED_EVENT, data={"trigger_id": trigger_id},
                    flow_id=flow.flow_id, execution_id=run.id, source_node=node.id,
                ))
                self._maybe_finalize(run)
                run_ids.append(run.id)
        return run_ids

    async def inject(
        self,
        flow_id: str,
        event: str,
        data: dict[str, Any] | None = None,
        *,
        execution_id: str | None = None,
        source_node: str = EXTERNAL_SOURCE,
        target_node: str | None = None,
    ) -> Optional[FlowEvent]:
        """External/entry point: deliver an event into a flow.

        Joins the run named by ``execution_id`` (how pysdk emissions come home)
        or starts a fresh one. ``target_node`` bypasses edge routing and
        delivers directly (the Inject panel's direct mode)."""
        flow = await self.load_flow(flow_id)
        if flow is None:
            raise ValueError(f"Unknown or unreadable flow: {flow_id}")
        if not flow.enabled:
            raise ValueError(f"Flow {flow_id} is not active")
        run = self._runs.get(execution_id) if execution_id else None
        if run is None:
            run = await self._start_run(flow)
        fe = FlowEvent(event=event, data=data or {}, flow_id=flow_id,
                       execution_id=run.id, source_node=source_node)
        if target_node:
            node = flow.doc.node(target_node)
            if node is None:
                raise ValueError(f"Unknown node: {target_node}")
            self._journal_event(run, fe)
            await self._deliver(run, node, fe)
        else:
            await self._route(run, fe)
        self._maybe_finalize(run)
        return fe

    async def _start_run(self, flow: _LoadedFlow) -> _Run:
        run = _Run(str(uuid.uuid4()), flow)
        self._runs[run.id] = run
        run.journal.append("run_start", {"flow_id": flow.flow_id, "run_id": run.id})
        try:
            from flow_sdk.builtin.agentic_flow_run import AgenticFlowRun, RunStatus

            row = AgenticFlowRun(id=run.id, name=f"run {run.id[:8]}", flow_id=flow.flow_id,
                                 status=RunStatus.RUNNING.value, started_at=now_iso())
            await row.save()
            parent = await AgenticFlow.get_by_id(flow.flow_id)
            if parent is not None:
                await parent.attach_child(row)
        except Exception:
            logger.debug("FlowManager: run row start-upsert failed", exc_info=True)
        await self._broadcast_run_event(run, "run_start", {})
        return run

    # ── routing ───────────────────────────────────────────────────────────────

    async def _route(self, run: _Run, fe: FlowEvent) -> None:
        """Deliver ``fe`` along the flow's edges (exact event or catch-all)."""
        run.hops = max(run.hops, fe.hop)
        run.events += 1
        self._journal_event(run, fe)
        if fe.hop > DEFAULT_MAX_HOPS:
            self._trip(run, f"hop {fe.hop} exceeds max {DEFAULT_MAX_HOPS}")
            return
        if run.deadline_exceeded:
            self._trip(run, f"run deadline {DEFAULT_DEADLINE_S}s exceeded")
            return
        for node in run.flow.doc.targets_for(fe.source_node, fe.event):
            await self._deliver(run, node, fe)

    async def _deliver(self, run: _Run, node: FlowNodeDef, fe: FlowEvent) -> None:
        if node.node_type == "trigger":
            return  # triggers accept no inputs
        rt = self._node_rt(run.flow.flow_id, node.id)
        nd = node.node_data
        if nd.get("merge_identical"):
            identity = _delivery_identity(fe)
            if any(_delivery_identity(p) == identity for p, _, _ in rt.queue):
                run.journal.append("merged", {"node": node.id, "event": fe.event})
                await self._broadcast_node_status(run, node, "merged")
                return
        rt.queue.append((fe, node, run))
        run.pending += 1
        await self._broadcast_node_status(run, node, "queued", {"event": fe.event})
        await self._drain(run.flow.flow_id, node)

    def _node_rt(self, flow_id: str, node_id: str) -> _NodeRuntime:
        key = (flow_id, node_id)
        rt = self._runtime.get(key)
        if rt is None:
            rt = self._runtime[key] = _NodeRuntime()
        return rt

    def _limit_for(self, node: FlowNodeDef) -> int:
        nd = node.node_data
        if nd.get("execution_mode") == "parallel":
            return max(1, int(nd.get("parallel_limit") or 1))
        return 1

    async def _drain(self, flow_id: str, node: FlowNodeDef) -> None:
        rt = self._node_rt(flow_id, node.id)
        limit = self._limit_for(node)
        while rt.queue and rt.active < limit:
            fe, node_def, run = rt.queue.popleft()
            run.pending -= 1
            rt.active += 1
            run.active += 1
            run.executions += 1
            try:
                await self._execute(run, node_def, fe, rt)
            except Exception as e:
                self._finish_execution(run, rt)
                logger.exception("FlowManager: node %s failed for %s", node_def.id, fe.event)
                run.journal.append("node_error", {"node": node_def.id, "error": str(e)})
                await self._broadcast_node_status(run, node_def, "failed", {"error": str(e)})
        self._maybe_finalize_all()

    def _finish_execution(self, run: _Run, rt: _NodeRuntime) -> None:
        rt.active -= 1
        run.active -= 1

    # ── execution per node type ───────────────────────────────────────────────

    async def _execute(self, run: _Run, node: FlowNodeDef, fe: FlowEvent, rt: _NodeRuntime) -> None:
        nd = node.node_data
        if node.node_type == "pysdk":
            await self._run_pysdk(run, node, fe, rt)
        elif nd.get("program_kind") == "callback":
            await self._run_callback(run, node, fe, rt)
        else:
            await self._spawn_agent(run, node, fe, rt)

    async def _run_callback(self, run: _Run, node: FlowNodeDef, fe: FlowEvent, rt: _NodeRuntime) -> None:
        from flow_sdk.builtin import trigger_callbacks

        name = str(node.node_data.get("program_ref") or "")
        fn = trigger_callbacks.get(name)
        if fn is None:
            raise RuntimeError(f"No registered callback {name!r}")
        await self._broadcast_node_status(run, node, "started", {"program_kind": "callback"})
        started = time.monotonic()
        try:
            result = fn(fe)
            if asyncio.iscoroutine(result):
                result = await result
        except BaseException:
            self._finish_execution(run, rt)
            raise
        duration = int((time.monotonic() - started) * 1000)
        run.journal.append("node_done", {"node": node.id, "duration_ms": duration})
        # A callback's dict return becomes its `done` event payload. Reserve the
        # successor hop (pending += 1, synchronous) BEFORE releasing this
        # execution slot — the run's counters must never hit 0/0 mid-handoff or
        # a concurrent finalize check could sink the run under us.
        await self.emit_from_node(run, node.id, AGENT_DONE_EVENT,
                                  result if isinstance(result, dict) else {})
        self._finish_execution(run, rt)
        await self._broadcast_node_status(run, node, "finished", {"duration_ms": duration})

    async def _spawn_agent(self, run: _Run, node: FlowNodeDef, fe: FlowEvent, rt: _NodeRuntime) -> None:
        from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
        from flow_sdk.builtin.flow_node import MODEL_SIZE_TO_CLI

        if run.processes >= DEFAULT_MAX_PROCESSES:
            self._finish_execution(run, rt)
            self._trip(run, f"max_processes {DEFAULT_MAX_PROCESSES} exhausted")
            return
        run.processes += 1
        nd = node.node_data
        instruction = self._agent_instruction(run, node, fe)
        proc = AgenticProcess(
            instruction_content=instruction,
            workdir=nd.get("workdir"),
            visible=bool(nd.get("visible", False)),
            name=f"Flow {run.flow.doc.name or run.flow.flow_id[:8]}: {node.name or node.id[:8]}",
            cli_config={"model": MODEL_SIZE_TO_CLI.get(str(nd.get("model_size") or "sm"), "haiku")},
        )
        await proc.save()
        await proc.start_pty(instruction=instruction, visible=bool(nd.get("visible", False)))
        try:
            from flow_sdk.builtin.agentic_flow_run import AgenticFlowRun

            row = await AgenticFlowRun.get_by_id(run.id)
            if row is not None:
                await row.attach_child(proc)
        except Exception:
            logger.debug("FlowManager: run→process attach failed", exc_info=True)
        run.journal.append("agent_spawn", {"node": node.id, "process_id": proc.id})
        await self._broadcast_node_status(run, node, "started",
                                          {"program_kind": nd.get("program_kind", "instruction"),
                                           "process_id": proc.id})
        asyncio.create_task(self._watch_agent(run, node, proc.id, rt))

    def _agent_instruction(self, run: _Run, node: FlowNodeDef, fe: FlowEvent) -> str:
        nd = node.node_data
        prompt = f" {nd.get('prompt')}" if nd.get("prompt") else ""
        base = (
            f"/{nd.get('program_ref')}{prompt}"
            if nd.get("program_kind") == "skill"
            else f"{nd.get('program_ref') or ''}{prompt}"
        )
        context = (
            f"\n\n---\nFlow event `{fe.event}` (flow {run.flow.doc.name or run.flow.flow_id}, "
            f"execution {run.id}).\nData:\n```json\n{json.dumps(fe.data, indent=2)}\n```\n"
            "When you finish, your final answer is emitted automatically as this node's "
            "`done` event — no further action needed."
        )
        return base + context

    async def _watch_agent(self, run: _Run, node: FlowNodeDef, proc_id: str, rt: _NodeRuntime) -> None:
        """One-shot agent execution: wait for the turn to complete (busy→idle),
        stop the process, auto-emit ``done {output}``, free the slot."""
        from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
        from flow_sdk.builtin.agentic_process.status_predicates import is_turn_busy
        from flow_sdk.builtin.process_lifecycle import ProcessStatus

        terminal = {ProcessStatus.STOPPED.value, ProcessStatus.FAILED.value}
        seen_busy = False
        started = time.monotonic()
        output = ""
        failed: Optional[str] = None
        try:
            while True:
                await asyncio.sleep(_SPAWN_WATCH_INTERVAL_S)
                if run.deadline_exceeded:
                    failed = "run deadline exceeded during agent execution"
                    break
                proc = await AgenticProcess.get_by_id(proc_id)
                if proc is None:
                    failed = "process disappeared"
                    break
                if proc.status == ProcessStatus.FAILED.value:
                    failed = proc.start_failure or "process failed"
                    break
                if proc.status in terminal:
                    output = await self._agent_output(proc)
                    break
                busy = is_turn_busy(proc)
                if busy:
                    seen_busy = True
                elif seen_busy:
                    output = await self._agent_output(proc)
                    try:
                        await proc.exit()
                    except Exception:
                        logger.exception("FlowManager: one-shot exit failed for %s", proc_id)
                    break
        except Exception:
            logger.exception("FlowManager: agent watcher failed for node %s", node.id)
            failed = "agent watcher failed"
        finally:
            duration = int((time.monotonic() - started) * 1000)
            if failed:
                self._finish_execution(run, rt)
                run.journal.append("node_error", {"node": node.id, "process_id": proc_id,
                                                  "error": failed, "duration_ms": duration})
                await self._broadcast_node_status(run, node, "failed",
                                                  {"error": failed, "process_id": proc_id,
                                                   "duration_ms": duration})
            else:
                run.journal.append("node_done", {"node": node.id, "process_id": proc_id,
                                                 "duration_ms": duration})
                # Reserve the successor hop (pending += 1, synchronous) BEFORE
                # releasing this execution slot — counters must never hit 0/0
                # mid-handoff or a concurrent finalize could sink the run.
                await self.emit_from_node(run, node.id, AGENT_DONE_EVENT,
                                          {"output": output, "process_id": proc_id})
                self._finish_execution(run, rt)
                await self._broadcast_node_status(run, node, "finished",
                                                  {"duration_ms": duration, "process_id": proc_id})
            await self._drain(run.flow.flow_id, node)
            self._maybe_finalize(run)

    @staticmethod
    async def _agent_output(proc: Any) -> str:
        """The agent's visible answer: last assistant text from its transcript.

        ``get_claude_session`` is a cheap path resolver (``include_content=False``)
        — it never carries ``last_assistant_text`` — so the text is recovered
        from the JSONL directly (the ``asset_cleanup.transcript_reply`` pattern).
        """
        try:
            from flow_sdk.asset_cleanup.run import transcript_reply
            from flow_sdk.builtin.agentic_process.agentic_process import get_claude_session

            if proc.session_id:
                record = get_claude_session(proc.session_id)
                jsonl_path = getattr(record, "jsonl_path", None)
                if jsonl_path:
                    text, _models = transcript_reply(Path(jsonl_path))
                    return text
        except Exception:
            logger.debug("FlowManager: agent output read failed", exc_info=True)
        return ""

    async def _run_pysdk(self, run: _Run, node: FlowNodeDef, fe: FlowEvent, rt: _NodeRuntime) -> None:
        from flow_sdk.flow_manager.pysdk_runner import run_pysdk_node

        await self._broadcast_node_status(run, node, "started", {"program_kind": "pysdk"})
        started = time.monotonic()
        try:
            result = await run_pysdk_node(run.flow.folder, node, fe, run)
        finally:
            self._finish_execution(run, rt)
        duration = int((time.monotonic() - started) * 1000)
        detail = {"duration_ms": duration, "exit_code": result.exit_code,
                  "stdout": result.stdout[-2000:], "stderr": result.stderr[-2000:]}
        if result.exit_code == 0:
            run.journal.append("node_done", {"node": node.id, **detail})
            await self._broadcast_node_status(run, node, "finished", detail)
        else:
            run.journal.append("node_error", {"node": node.id, **detail})
            await self._broadcast_node_status(
                run, node, "failed",
                {**detail, "error": f"exit {result.exit_code}: {result.stderr.strip()[-300:]}"},
            )

    # ── emissions from nodes ──────────────────────────────────────────────────

    async def emit_from_node(self, run: _Run, node_id: str, event: str, data: dict[str, Any]) -> None:
        fe = FlowEvent(event=event, data=data, flow_id=run.flow.flow_id,
                       execution_id=run.id, source_node=node_id, hop=run.hops + 1)
        # Chain hops run as loop tasks, not stack frames — long chains (and the
        # hop-capped cycle case) must never grow the call stack. The pending
        # counter keeps the run alive until the scheduled hop lands.
        run.pending += 1

        async def _hop() -> None:
            try:
                await self._route(run, fe)
            finally:
                run.pending -= 1
                self._maybe_finalize(run)

        asyncio.ensure_future(_hop())

    # ── run lifecycle ─────────────────────────────────────────────────────────

    def _trip(self, run: _Run, reason: str) -> None:
        run.error = reason
        run.journal.append("tripped", {"reason": reason})
        logger.warning("FlowManager: run %s tripped: %s", run.id, reason)

    def _maybe_finalize_all(self) -> None:
        for run in list(self._runs.values()):
            self._maybe_finalize(run)

    def _maybe_finalize(self, run: _Run) -> None:
        if not run.maybe_sink():
            return
        run.finalized = True
        asyncio.ensure_future(self._finalize(run))

    async def _finalize(self, run: _Run) -> None:
        from flow_sdk.builtin.agentic_flow_run import AgenticFlowRun, RunStatus

        status = RunStatus.TRIPPED.value if run.error else RunStatus.COMPLETE.value
        run.journal.append("run_end", {"status": status, "events": run.events,
                                       "executions": run.executions, "error": run.error})
        try:
            row = await AgenticFlowRun.get_by_id(run.id)
            if row is not None:
                row.status = status
                row.ended_at = now_iso()
                row.event_count = run.events
                row.execution_count = run.executions
                row.error = run.error
                await row.update()
        except Exception:
            logger.debug("FlowManager: run row end-upsert failed", exc_info=True)
        await self._broadcast_run_event(run, "run_end", {"status": status})
        self._runs.pop(run.id, None)

    # ── observability ─────────────────────────────────────────────────────────

    def _journal_event(self, run: _Run, fe: FlowEvent) -> None:
        run.journal.append("event", {"event": fe.event, "data": fe.data,
                                     "source_node": fe.source_node, "hop": fe.hop})
        asyncio.ensure_future(self._broadcast_run_event(
            run, "event", {"event": fe.event, "data": fe.data, "node": fe.source_node}))

    async def _broadcast_run_event(self, run: _Run, kind: str, payload: dict[str, Any]) -> None:
        try:
            from flow_sdk.api.messages import FlowRunEventMessage
            from flow_sdk.server.routes.websocket import broadcast

            await broadcast(FlowRunEventMessage(
                flow_id=run.flow.flow_id, run_id=run.id, kind=kind,
                event=str(payload.get("event") or ""), data=payload.get("data") or {},
                node=str(payload.get("node") or ""), status=str(payload.get("status") or ""),
                ts=now_iso(),
            ).model_dump_json())
        except Exception:
            logger.debug("FlowManager: run-event broadcast unavailable", exc_info=True)

    async def _broadcast_node_status(
        self, run: _Run, node: FlowNodeDef, phase: str, detail: dict[str, Any] | None = None
    ) -> None:
        rt = self._node_rt(run.flow.flow_id, node.id)
        try:
            from flow_sdk.api.messages import FlowNodeStatusMessage
            from flow_sdk.server.routes.websocket import broadcast

            await broadcast(FlowNodeStatusMessage(
                flow_id=run.flow.flow_id, run_id=run.id, node_id=node.id, phase=phase,
                queued=len(rt.queue), active=rt.active, detail=detail or {}, ts=now_iso(),
            ).model_dump_json())
        except Exception:
            logger.debug("FlowManager: node-status broadcast unavailable", exc_info=True)

    # ── run queries (routes) ──────────────────────────────────────────────────

    def live_run_ids(self) -> list[str]:
        return list(self._runs.keys())


_manager: Optional[FlowManager] = None


def get_flow_manager() -> FlowManager:
    global _manager
    if _manager is None:
        _manager = FlowManager()
    return _manager
