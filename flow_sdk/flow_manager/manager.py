"""FlowManager v2 — runs AgenticFlow documents.

Model: an AgenticFlow is a folder document (``graph.json``); events are LOCAL
to their flow; edges ``{from: {node, event}, to: {node}}`` are the only
routing (``"*"`` = catch-all). A run (execution_id) starts on trigger fire or
injection and sinks when no deliveries are pending and no executions are
active. Everything a run does is journaled to ``runs/<run-id>.jsonl`` and
mirrored over WS.

Node execution — palette trio:
* ``agent``    — spawned worker (skill/instruction); AUTO-EMITS ``done
  {output, output_files}`` when its turn completes.
* ``function`` — a FlowFunction (``on_flow_event(event_name, data, flow_ctx)``)
  run ``inline`` (server loop, registry name) or in a ``subprocess`` (script
  or registry name; see function_runner.py). A non-None dict return
  auto-emits ``done`` in BOTH runtimes.
* ``trigger``  — never executes; emits ``fired`` when its Trigger entity fires.

Standardized I/O records — one convention at every altitude:
* agent + subprocess executions: the AgenticProcess's OWN record folders
  (``execution/{input,output}``); the journal carries ``process_id``.
* inline executions: ``<run record dir>/executions/<seq>-<node>/{input,output}``.
* the RUN itself: ``records_root/agentic_flow_run/<stem>/execution/{input,output}``
  — entry events in, terminal (unrouted) emissions out.
Every finished execution and run is stamped with ``example.json`` (Dataset
IO_FOLDER-compatible; deterministic id) — runs are born as training data.

The per-node scheduler (serial/parallel, queue, merge_identical) is keyed by
(flow, node). Budgets + run retention come from the flow's ``config`` block.
"""
from __future__ import annotations

import asyncio
import json
import logging
import shutil
import time
import uuid
from collections import OrderedDict
from pathlib import Path
from typing import Any, Optional

from flow_sdk.builtin.agentic_flow import AgenticFlow
from flow_sdk.core.capabilities.models import now_iso
from flow_sdk.flow_manager.envelope import EXTERNAL_SOURCE, RunEvent
from flow_sdk.flow_manager.flow_doc import (
    AGENT_DONE_EVENT,
    TRIGGER_FIRED_EVENT,
    FlowDoc,
    FlowNodeDef,
    parse_flow_doc,
)
from flow_sdk.flow_manager.function_runner import record_emission
from flow_sdk.flow_manager.journal import RunJournal

logger = logging.getLogger(__name__)

_SPAWN_WATCH_INTERVAL_S = 2.0
RUN_RECORD_TYPE = "agentic_flow_run"


def run_record_dir(run_id: str) -> Path:
    """The run's standardized record home (same convention as process records)."""
    from flow_sdk.fs_store.record_paths import shadow_dir_for

    return shadow_dir_for(RUN_RECORD_TYPE, run_id)


def inline_exec_dir(run_id: str, seq: int, node_id: str) -> Path:
    """An INLINE execution's record home under the run — the one owner of the
    ``executions/<seq>-<node>`` layout (writers and rerun both resolve here)."""
    return run_record_dir(run_id) / "executions" / f"{seq}-{node_id}"


def execution_base(proc: Any) -> Path:
    """A PROCESS execution's record home — the one owner of the
    ``<record_dir>/execution`` layout (executors and rerun both resolve here)."""
    return proc._record_dir() / "execution"


def prepare_execution_io(base: Path, fe: "RunEvent") -> tuple[Path, Path]:
    """Materialize the standardized I/O record for one execution: mkdir
    ``input/`` + ``output/`` and write ``input/event.json``. THE one writer of
    the input-record convention. Best-effort — a read-only disk never fails
    the execution."""
    input_dir, output_dir = base / "input", base / "output"
    try:
        input_dir.mkdir(parents=True, exist_ok=True)
        output_dir.mkdir(parents=True, exist_ok=True)
        _write_json(input_dir / "event.json", fe.model_dump())
    except OSError:
        logger.debug("FlowManager: execution input record failed", exc_info=True)
    return input_dir, output_dir


def _write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, default=str) + "\n", encoding="utf-8")


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
    """Live run state: counters + journal + record dir. Row upserts at start/end."""

    __slots__ = ("id", "flow", "journal", "started_at", "pending", "active",
                 "hops", "processes", "events", "executions", "error", "finalized",
                 "seq", "in_count", "out_count", "record_dir", "suspended",
                 "suspended_nodes", "actor")

    def __init__(self, run_id: str, flow: _LoadedFlow) -> None:
        self.id = run_id
        self.flow = flow
        self.journal = RunJournal(flow.folder, run_id)
        self.started_at = time.monotonic()
        # BORN RESERVED: a fresh run starts with pending=1 — the ENTRY RESERVE.
        # _start_run awaits (row save/attach/broadcast) while the run is already
        # registered; without the reserve a concurrent drain's finalize sweep
        # latches `finalized` before the entry event ever routes (seen live:
        # a TOPIC trigger firing from another run's entity write). The entry
        # path (on_trigger_fired / inject) releases it after first routing.
        self.pending = 1
        self.active = 0       # executions in flight
        self.hops = 0
        self.processes = 0
        self.events = 0
        self.executions = 0
        self.seq = 0          # execution sequence (journal-ordered)
        self.in_count = 0     # entry events materialized (input/event-N.json)
        self.out_count = 0    # terminal events materialized (output/event-N.json)
        self.error: Optional[str] = None
        self.finalized = False
        self.record_dir: Path = run_record_dir(run_id)
        # guided_step parking: a run waits at a human-driven node until the
        # frontend injects its `done`. `suspended` keeps the run alive (mirrors
        # pending/active in maybe_sink); `suspended_nodes` lets inject find the
        # awaiting node to release before routing.
        self.suspended = 0
        self.suspended_nodes: set[str] = set()
        # The entry event's actor (target form) — stamps example provenance.
        self.actor: Optional[str] = None

    @property
    def deadline_exceeded(self) -> bool:
        return time.monotonic() - self.started_at > self.flow.doc.config.deadline_s

    def next_seq(self) -> int:
        self.seq += 1
        return self.seq

    def maybe_sink(self) -> bool:
        return (not self.finalized and self.pending == 0 and self.active == 0
                and self.suspended == 0)


class _NodeRuntime:
    """Per-(flow,node) scheduler state: pending deliveries + in-flight count.

    ``pending_ids`` mirrors the queue's delivery identities so merge_identical
    is an O(1) membership check instead of re-serializing the whole queue."""

    __slots__ = ("queue", "active", "pending_ids")

    def __init__(self) -> None:
        from collections import deque

        self.queue: "deque[tuple[RunEvent, FlowNodeDef, _Run]]" = deque()
        self.active = 0
        self.pending_ids: set[str] = set()

    @property
    def idle(self) -> bool:
        return not self.queue and self.active == 0


class InlineFlowCtx:
    """``flow_ctx`` for the INLINE runtime — same surface as the subprocess one.

    Runs on the server event loop with direct SDK access. ``emit_flow_event``
    routes through the manager (run counters stay correct); ``log`` mirrors to
    the logger and the execution's output record.
    """

    def __init__(self, manager: "FlowManager", run: _Run, node: FlowNodeDef,
                 input_folder: Path, output_folder: Path) -> None:
        self._manager = manager
        self._run = run
        self._node = node
        self.flow_id = run.flow.flow_id
        self.node_id = node.id
        self.execution_id = run.id
        self.input_folder = input_folder
        self.output_folder = output_folder
        self.flow_output_folder = run.record_dir / "execution" / "output"
        self.logs: list[str] = []

    def emit_flow_event(self, key: str, val: Any = None) -> None:
        data = val if isinstance(val, dict) else {"value": val}
        record_emission(self.output_folder, key, data)
        # emit_from_node is sync: the pending reserve lands NOW, before this
        # function returns to the loop — the hop itself runs as a loop task.
        self._manager.emit_from_node(self._run, self.node_id, key, data)

    async def post(self, path: str, body: dict, *, timeout: int = 60) -> dict:
        """ASYNC in the inline runtime (unlike the subprocess ctx): the HTTP
        round-trip targets THIS server, so a blocking call on the event loop
        would deadlock against itself. Await it — or better, skip HTTP
        entirely: inline functions have direct SDK access."""
        from flow_sdk.flow_manager.function_runner import FlowCtx as _SubCtx
        from flow_sdk.flow_manager.function_runner import _api_base

        sub = _SubCtx(self.flow_id, self.node_id, self.execution_id, _api_base())
        return await asyncio.get_running_loop().run_in_executor(
            None, lambda: sub.post(path, body, timeout=timeout))

    def log(self, msg: Any) -> None:
        logger.info("[flow %s/%s] %s", self.flow_id[:8], self.node_id, msg)
        self.logs.append(str(msg))


def _delivery_identity(event: RunEvent) -> str:
    return f"{event.event}|{json.dumps(event.data, sort_keys=True, default=str)}"


# Entity types that back a flow doc — the same folder shape (asset_ref /
# enabled / graph.json) driven by this engine. AgenticFlow is the native type;
# any other folder-doc type (e.g. Journey, typed separately so it stays out of
# the Flows list) REGISTERS its loader on import instead of being special-cased
# here — membership is data, not an if/else chain.
_FLOW_ENTITY_LOADERS: list[Any] = [AgenticFlow.get_by_id]


def register_flow_entity_loader(loader: Any) -> None:
    """Register an async ``flow_id -> entity | None`` loader for a folder-doc
    entity type that runs on FlowManager."""
    if loader not in _FLOW_ENTITY_LOADERS:
        _FLOW_ENTITY_LOADERS.append(loader)


async def _resolve_flow_entity(flow_id: str) -> Any:
    """The flow's backing entity, resolved through the registered loaders."""
    for loader in _FLOW_ENTITY_LOADERS:
        try:
            entity = await loader(flow_id)
        except Exception:
            entity = None
        if entity is not None:
            return entity
    return None


class FlowManager:
    def __init__(self) -> None:
        self._flows: dict[str, _LoadedFlow] = {}
        self._runs: dict[str, _Run] = {}
        self._runtime: dict[tuple[str, str], _NodeRuntime] = {}
        # Graph-level bus subscriptions (docs/flow-events.md phase 5):
        # flow id → live unsubscribers, re-armed whenever the doc (re)loads.
        self._flow_subs: dict[str, list] = {}
        # Bounded LRU of consumed (flow_id, envelope_id) entries — at-least-once
        # delivery must not double-start a run, while ONE envelope fanning out
        # to several subscribed flows must enter each of them (bus law 2 made
        # concrete at the door, per flow).
        self._seen_entry_ids: "OrderedDict[tuple[str, str], None]" = OrderedDict()
        # Per-flow subscription-entry storm cap (config.max_entries_per_minute)
        # — the shared topics-owned guard shape.
        self._entry_guard = None  # built lazily (topics import)
        self._rearm_unsub = None  # the entity.updated re-arm subscription

    # ── flow loading (disk is truth; mtime-validated cache) ───────────────────

    async def load_flow(self, flow_id: str, entity: AgenticFlow | None = None) -> Optional[_LoadedFlow]:
        if entity is None:
            entity = await _resolve_flow_entity(flow_id)
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
        self._arm_subscriptions(loaded)
        return loaded

    async def flows_referencing_trigger(self, trigger_id: str) -> list[_LoadedFlow]:
        out: list[_LoadedFlow] = []
        for entity in await AgenticFlow.get_all({}):
            loaded = await self.load_flow(entity.id, entity)
            if loaded and loaded.enabled and trigger_id in loaded.doc.trigger_ids():
                out.append(loaded)
        return out

    # ── graph-level bus subscriptions (phase 5) ───────────────────────────────

    def _arm_subscriptions(self, loaded: _LoadedFlow) -> None:
        """(Re-)arm the flow's ``subscriptions:`` block — replace semantics on
        every doc (re)load; a disabled flow disarms."""
        from flow_sdk.topics import event_bus

        for unsub in self._flow_subs.pop(loaded.flow_id, []):
            unsub()
        if self._entry_guard is not None:
            self._entry_guard.clear(loaded.flow_id)
        if not loaded.enabled or not loaded.doc.subscriptions:
            return
        unsubs = []
        for sub in loaded.doc.subscriptions:
            unsubs.append(event_bus.on(
                sub.pattern,
                self._subscription_handler(loaded.flow_id, sub),
                target=sub.target or None,
                scope=list(sub.scope) or None,
            ))
        self._flow_subs[loaded.flow_id] = unsubs
        logger.info("FlowManager: %s armed %d subscription(s)",
                    loaded.flow_id[:8], len(unsubs))

    def _subscription_handler(self, flow_id: str, sub):
        from flow_sdk.topics.envelope import FlowEvent, target_of

        async def _on_event(event: "FlowEvent") -> None:
            # SELF-LOOP BRAKE: every flow.* boundary emission carries its own
            # flow in ctx.scope — a flow subscribing to its own boundaries
            # would spawn runs forever. Cross-flow chaining stays legal.
            if target_of("agentic_flow", flow_id) in event.ctx.scope:
                return
            # Entry dedup (bounded LRU), PER FLOW: at-least-once can't
            # double-start this flow, but the same envelope fanning out to
            # other subscribed flows still enters each of them.
            dedup_key = (flow_id, event.id)
            if dedup_key in self._seen_entry_ids:
                return
            self._seen_entry_ids[dedup_key] = None
            while len(self._seen_entry_ids) > 1024:
                self._seen_entry_ids.popitem(last=False)
            if not self._entry_storm_allows(flow_id):
                return
            try:
                await self.inject(
                    flow_id,
                    sub.event or event.topic,
                    {"topic": event.topic, "target": event.target, "data": event.data},
                    target_node=sub.node or None,
                    envelope=event,
                )
            except ValueError as e:
                logger.warning("FlowManager: subscription entry refused for %s: %s",
                               flow_id[:8], e)

        return _on_event

    def _entry_storm_allows(self, flow_id: str) -> bool:
        """Cap subscription entries per flow per minute — bounds cross-flow
        ping-pong (fresh envelopes per hop defeat id-dedup and the self-brake).
        One warning per window, never silent. Shared guard shape from topics/."""
        if self._entry_guard is None:
            from flow_sdk.topics import FixedWindowStormGuard

            self._entry_guard = FixedWindowStormGuard()
        loaded = self._flows.get(flow_id)
        cap = loaded.doc.config.max_entries_per_minute if loaded else 30

        def _warn() -> None:
            logger.warning(
                "FlowManager: %s subscription entries exceeded %d/min — "
                "suppressing until the window resets (cross-flow loop?)",
                flow_id[:8], cap)

        return self._entry_guard.allows(flow_id, cap, _warn)

    async def arm_all_flow_subscriptions(self) -> None:
        """Boot sweep — flows load lazily, so subscription-only flows must be
        loaded (and thereby armed) once at startup. After boot, graph edits
        re-arm through the entity.updated re-arm subscription below."""
        from flow_sdk.topics import event_bus

        # Conscious no-unscoped-get_all exception: a boot-time SYSTEM sweep
        # (same class as flows_referencing_trigger above) — flows must be
        # loaded to know whether their doc declares subscriptions; no row data
        # leaves the process.
        for entity in await AgenticFlow.get_all({}):
            try:
                await self.load_flow(entity.id, entity)
            except Exception:
                logger.exception("FlowManager: boot subscription arm failed for %s", entity.id)
        if self._rearm_unsub is None:
            # Bus dogfooding: an AgenticFlow save re-loads + re-arms that flow.
            async def _rearm(event) -> None:
                flow_id = str(event.data.get("id") or "")
                if not flow_id:
                    return
                self._flows.pop(flow_id, None)  # force mtime-independent reload
                if await self.load_flow(flow_id) is None and flow_id in self._flow_subs:
                    # Reload failed (bad graph / gone entity): disarm the stale
                    # subscriptions rather than leaving them live against a doc
                    # that no longer parses.
                    for unsub in self._flow_subs.pop(flow_id, []):
                        unsub()
                    logger.warning("FlowManager: %s subscriptions disarmed (reload failed)",
                                   flow_id[:8])

            self._rearm_unsub = event_bus.on(
                "entity.updated", _rearm, target="agentic_flow:*")

    # ── activation ────────────────────────────────────────────────────────────

    async def on_trigger_fired(self, trigger_id: str, envelope: Any = None) -> list[str]:
        """Trigger fire → start a run in every active flow referencing it.
        Returns started run ids. Called from the trigger fire paths.
        ``envelope`` (topic-trigger fires) preserves the triggering
        FlowEvent's id/actor onto the entry RunEvent — the relay law at this
        door too, matching the subscription path."""
        run_ids: list[str] = []
        for flow in await self.flows_referencing_trigger(trigger_id):
            for node in flow.doc.trigger_nodes_for(trigger_id):
                run = await self._start_run(flow)  # born reserved (see _Run)
                try:
                    extra: dict[str, Any] = {}
                    if envelope is not None:
                        extra = {"id": envelope.id, "actor": envelope.ctx.actor}
                    fe = RunEvent(
                        event=TRIGGER_FIRED_EVENT, data={"trigger_id": trigger_id},
                        flow_id=flow.flow_id, execution_id=run.id, source_node=node.id,
                        **extra,
                    )
                    if run.actor is None and fe.actor:
                        run.actor = fe.actor
                    self._record_run_event(run, fe, "input")
                    await self._route(run, fe)
                finally:
                    run.pending -= 1
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
        envelope: Any = None,
    ) -> Optional[RunEvent]:
        """External/entry point: deliver an event into a flow.

        Joins the run named by ``execution_id`` (how subprocess emissions come
        home) or starts a fresh one. ``target_node`` bypasses edge routing and
        delivers directly (the Inject panel's direct mode)."""
        flow = await self.load_flow(flow_id)
        if flow is None:
            raise ValueError(f"Unknown or unreadable flow: {flow_id}")
        if not flow.enabled:
            raise ValueError(f"Flow {flow_id} is not active")
        run = self._runs.get(execution_id) if execution_id else None
        if run is None:
            run = await self._start_run(flow)  # born reserved (see _Run)
        else:
            # JOIN RESERVE: the delivery below must land before any concurrent
            # finalize sweep evaluates this run — covers the guided-release gap
            # (suspended decremented before the successor's pending reserve).
            run.pending += 1
        try:
            # Provenance alignment (phase 7): a run entered FROM a bus envelope
            # preserves its id + actor — the relay law at the flow door.
            extra: dict[str, Any] = {}
            if envelope is not None:
                extra = {"id": envelope.id, "actor": envelope.ctx.actor}
            fe = RunEvent(event=event, data=data or {}, flow_id=flow_id,
                          execution_id=run.id, source_node=source_node, **extra)
            if run.actor is None and fe.actor:
                run.actor = fe.actor
            if source_node == EXTERNAL_SOURCE:
                self._record_run_event(run, fe, "input", target_node=target_node)
            # A guided_step advance: the frontend injects the parked node's `done`.
            if source_node in run.suspended_nodes:
                run.suspended_nodes.discard(source_node)
                run.suspended = max(0, run.suspended - 1)
                self._emit_flow_topic(run, "step.done", {"node_id": source_node, "event": event})
            if target_node:
                node = flow.doc.node(target_node)
                if node is None:
                    raise ValueError(f"Unknown node: {target_node}")
                self._journal_event(run, fe)
                await self._deliver(run, node, fe)
            else:
                await self._route(run, fe)
        finally:
            run.pending -= 1
            # Inside finally: a raise above (e.g. unknown target node) must not
            # orphan a fresh run at 0/0 until some later sweep finds it.
            self._maybe_finalize(run)
        return fe

    async def _start_run(self, flow: _LoadedFlow) -> _Run:
        run = _Run(str(uuid.uuid4()), flow)
        self._runs[run.id] = run
        # The run's standardized record home (process-folder convention).
        try:
            (run.record_dir / "execution" / "input").mkdir(parents=True, exist_ok=True)
            (run.record_dir / "execution" / "output").mkdir(parents=True, exist_ok=True)
        except OSError:
            logger.exception("FlowManager: run record dir create failed for %s", run.id)
        run.journal.append("run_start", {"flow_id": flow.flow_id, "run_id": run.id})
        try:
            from flow_sdk.builtin.agentic_flow_run import AgenticFlowRun, RunStatus

            row = AgenticFlowRun(id=run.id, name=f"run {run.id[:8]}", flow_id=flow.flow_id,
                                 status=RunStatus.RUNNING.value, started_at=now_iso())
            await row.save()
            parent = await _resolve_flow_entity(flow.flow_id)
            if parent is not None:
                await parent.attach_child(row)
        except Exception:
            logger.debug("FlowManager: run row start-upsert failed", exc_info=True)
        await self._broadcast_run_event(run, "run_start", {})
        self._emit_flow_topic(run, "started", {})
        return run

    # ── unified-bus boundary emissions (docs/flow-events.md phase 2) ──────────

    def _emit_flow_topic(self, run: _Run, subtopic: str, data: dict[str, Any]) -> None:
        """Dual-publish a run BOUNDARY onto the unified bus (flow.<subtopic>).
        Run-internal node statuses stay on the legacy WS mirror — boundaries
        only. Best-effort: the engine never fails on bus trouble."""
        try:
            from flow_sdk.topics import emit_topic
            from flow_sdk.topics.envelope import target_of

            emit_topic(
                f"flow.{subtopic}",
                target_of("agentic_flow", run.flow.flow_id),
                {"run_id": run.id, **data},
                ctx={"scope": [target_of("agentic_flow_run", run.id),
                               target_of("agentic_flow", run.flow.flow_id)]},
            )
        except Exception:
            logger.debug("FlowManager: flow.%s emission failed", subtopic, exc_info=True)

    # ── standardized I/O records ──────────────────────────────────────────────

    def _record_run_event(self, run: _Run, fe: RunEvent, direction: str,
                          target_node: str | None = None) -> None:
        """The run-level I/O record: entry events → ``input/event-N.json``,
        terminal (unrouted) emissions → ``output/event-N.json`` (numbered =
        Dataset occurrence grammar). ``target_node`` (direct delivery) rides
        along on inputs so replay reproduces the exact entry semantics."""
        if direction == "input":
            run.in_count += 1
            n = run.in_count
        else:
            run.out_count += 1
            n = run.out_count
        payload = fe.model_dump()
        if target_node:
            payload["target_node"] = target_node
        try:
            _write_json(run.record_dir / "execution" / direction / f"event-{n}.json", payload)
        except OSError:
            logger.debug("FlowManager: run %s record failed", direction, exc_info=True)
        if direction == "output":
            self._emit_flow_topic(run, "output", {"event": fe.event, "payload": fe.data})

    def _stamp_example(self, exec_dir: Path, run: _Run, node_id: str, seq: int,
                       fe: RunEvent | None, process_id: str | None = None,
                       agent_id: str | None = None) -> None:
        """Born-compatible Dataset example: id is deterministic → idempotent promotion."""
        from flow_sdk.fs_store.identifier import mint_uuid

        source: dict[str, Any] = {"flow_id": run.flow.flow_id, "run_id": run.id,
                                  "node_id": node_id, "seq": seq}
        if fe is not None:
            source.update({"event": fe.event, "source_node": fe.source_node,
                           "hop": fe.hop, "event_id": fe.id})
        if run.actor:
            source["actor"] = run.actor
        if process_id:
            source["process_id"] = process_id
        if agent_id:
            source["agent_id"] = agent_id
        try:
            from flow_sdk.builtin.dataset import EXAMPLE_META

            _write_json(exec_dir / EXAMPLE_META, {
                "metadata": {
                    "id": str(mint_uuid(f"{run.flow.flow_id}:{run.id}:{seq}")),
                    "kind": "train",
                    "source": source,
                },
            })
        except OSError:
            logger.debug("FlowManager: example.json stamp failed", exc_info=True)

    # ── routing ───────────────────────────────────────────────────────────────

    async def _route(self, run: _Run, fe: RunEvent) -> None:
        """Deliver ``fe`` along the flow's edges (exact event or catch-all)."""
        cfg = run.flow.doc.config
        run.hops = max(run.hops, fe.hop)
        run.events += 1
        self._journal_event(run, fe)
        if fe.hop > cfg.max_hops:
            self._trip(run, f"hop {fe.hop} exceeds max {cfg.max_hops}")
            return
        if run.deadline_exceeded:
            self._trip(run, f"run deadline {cfg.deadline_s}s exceeded")
            return
        targets = run.flow.doc.targets_for(fe.source_node, fe.event)
        if not targets:
            # A node emission that routes nowhere is a FLOW OUTPUT.
            src = run.flow.doc.node(fe.source_node)
            if src is not None and src.node_type != "trigger":
                self._record_run_event(run, fe, "output")
            return
        for node in targets:
            await self._deliver(run, node, fe)

    async def _deliver(self, run: _Run, node: FlowNodeDef, fe: RunEvent) -> None:
        if node.node_type == "trigger":
            return  # triggers accept no inputs
        rt = self._node_rt(run.flow.flow_id, node.id)
        nd = node.node_data
        if nd.get("merge_identical"):
            identity = _delivery_identity(fe)
            if identity in rt.pending_ids:
                run.journal.append("merged", {"node": node.id, "event": fe.event})
                await self._broadcast_node_status(run, node, "merged")
                return
            rt.pending_ids.add(identity)
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
            rt.pending_ids.discard(_delivery_identity(fe))
            run.pending -= 1
            rt.active += 1
            run.active += 1
            run.executions += 1
            seq = run.next_seq()
            try:
                await self._execute(run, node_def, fe, rt, seq)
            except Exception as e:
                self._finish_execution(run, rt)
                logger.exception("FlowManager: node %s failed for %s", node_def.id, fe.event)
                run.journal.append("node_error", {"node": node_def.id, "error": str(e),
                                                  "execution": {"seq": seq}})
                await self._broadcast_node_status(run, node_def, "failed", {"error": str(e)})
        # Reap the per-node runtime when fully idle — the map otherwise grows
        # one entry per (flow, node) forever (in-flight agents keep active > 0
        # until their watcher drains again; deliveries recreate on demand).
        if rt.idle:
            self._runtime.pop((flow_id, node.id), None)
        self._maybe_finalize_all()

    def _finish_execution(self, run: _Run, rt: _NodeRuntime) -> None:
        rt.active -= 1
        run.active -= 1

    # ── execution per node type ───────────────────────────────────────────────

    async def _execute(self, run: _Run, node: FlowNodeDef, fe: RunEvent,
                       rt: _NodeRuntime, seq: int) -> None:
        if node.node_type == "guided_step":
            await self._enter_guided_step(run, node, fe, rt, seq)
        elif node.node_type == "function":
            await self._run_function(run, node, fe, rt, seq)
        else:
            await self._spawn_agent(run, node, fe, rt, seq)

    # ── guided_step (User Journey — human-in-the-loop) ────────────────────────

    async def _enter_guided_step(self, run: _Run, node: FlowNodeDef, fe: RunEvent,
                                 rt: _NodeRuntime, seq: int) -> None:
        """Park the run at a guided step: record the entry, broadcast the
        "waiting for you to…" one-liner, then RESERVE ``suspended`` (keeps the
        run alive) and release this execution slot WITHOUT emitting ``done``.
        The frontend orchestrator injects this node's ``done`` when the step's
        standard signal (dock reached / entity query / process status) is
        satisfied — see ``inject`` for the release + route."""
        exec_dir = inline_exec_dir(run.id, seq, node.id)
        prepare_execution_io(exec_dir, fe)
        nd = node.node_data
        detail = {
            "status_line": nd.get("status_line") or "",
            "present": nd.get("present") or {},
            "await": nd.get("await") or {},
        }
        run.journal.append("guided_wait", {"node": node.id, "execution": {"seq": seq}, **detail})
        # Reserve BEFORE releasing the slot — counters must never hit 0/0 while a
        # step is parked, or a concurrent finalize would sink a waiting run.
        run.suspended += 1
        run.suspended_nodes.add(node.id)
        self._finish_execution(run, rt)
        await self._broadcast_node_status(run, node, "waiting", detail)
        self._emit_flow_topic(run, "waiting", {"node_id": node.id, "seq": seq, **detail})

    # ── FlowFunction execution (inline + subprocess) ──────────────────────────

    async def _run_function(self, run: _Run, node: FlowNodeDef, fe: RunEvent,
                            rt: _NodeRuntime, seq: int) -> None:
        if node.function_runtime() == "inline":
            await self._run_function_inline(run, node, fe, rt, seq)
        else:
            await self._run_function_subprocess(run, node, fe, rt, seq)


    async def _run_function_inline(self, run: _Run, node: FlowNodeDef, fe: RunEvent,
                                   rt: _NodeRuntime, seq: int) -> None:
        from flow_sdk.flow_manager import flow_functions

        ref = str(node.node_data.get("function") or "")
        fn = flow_functions.get(ref)
        if fn is None:
            self._finish_execution(run, rt)
            raise RuntimeError(f"No registered FlowFunction {ref!r}")
        exec_dir = inline_exec_dir(run.id, seq, node.id)
        input_dir, output_dir = prepare_execution_io(exec_dir, fe)
        ctx = InlineFlowCtx(self, run, node, input_dir, output_dir)
        await self._broadcast_node_status(run, node, "started", {"runtime": "inline"})
        started = time.monotonic()
        try:
            result = fn(fe.event, fe.data, ctx)
            if asyncio.iscoroutine(result):
                result = await result
        except BaseException as e:
            try:
                (output_dir / "error.txt").write_text(str(e), encoding="utf-8")
            except OSError:
                pass
            self._finish_execution(run, rt)
            raise
        duration = int((time.monotonic() - started) * 1000)
        try:
            _write_json(output_dir / "result.json", result if isinstance(result, dict) else {})
            if ctx.logs:
                (output_dir / "log.txt").write_text("\n".join(ctx.logs) + "\n", encoding="utf-8")
        except OSError:
            pass
        self._stamp_example(exec_dir, run, node.id, seq, fe)
        run.journal.append("node_done", {"node": node.id, "duration_ms": duration,
                                         "execution": {"seq": seq}})
        # Reserve the successor hop (pending += 1, synchronous) BEFORE releasing
        # this execution slot — counters must never hit 0/0 mid-handoff.
        if isinstance(result, dict):
            self.emit_from_node(run, node.id, AGENT_DONE_EVENT, result)
        self._finish_execution(run, rt)
        await self._broadcast_node_status(run, node, "finished",
                                          {"duration_ms": duration, "runtime": "inline"})

    async def _run_function_subprocess(self, run: _Run, node: FlowNodeDef, fe: RunEvent,
                                       rt: _NodeRuntime, seq: int) -> None:
        from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
        from flow_sdk.builtin.process_lifecycle import ProcessStatus
        from flow_sdk.flow_manager.function_runner import run_function_subprocess
        from flow_sdk.flowpad_types.enums.process_enums import ProcessKind

        # A real (hidden) process row: driverless — the manager runs the
        # subprocess itself and stamps status/exit_code; the row exists so the
        # execution has its OWN standard folders and joins the run's children.
        proc = AgenticProcess(
            visible=False,
            process_type=ProcessKind.EXECUTION.value,
            name=f"Flow {run.flow.doc.name or run.flow.flow_id[:8]}: {node.name or node.id[:8]}",
        )
        await proc.save()
        exec_base = execution_base(proc)
        input_dir, output_dir = prepare_execution_io(exec_base, fe)
        await self._attach_to_run(run, proc)
        await self._broadcast_node_status(run, node, "started",
                                          {"runtime": "subprocess", "process_id": proc.id})
        started = time.monotonic()
        folders = {"input": str(input_dir), "output": str(output_dir),
                   "flow_output": str(run.record_dir / "execution" / "output")}
        try:
            result = await run_function_subprocess(run.flow.folder, node, fe, run, folders)
        except BaseException:
            self._finish_execution(run, rt)
            raise
        duration = int((time.monotonic() - started) * 1000)
        # Full stdio lives in the execution record; the journal keeps tails.
        try:
            (output_dir / "stdout.log").write_text(result.stdout, encoding="utf-8")
            (output_dir / "stderr.log").write_text(result.stderr, encoding="utf-8")
        except OSError:
            pass
        self._stamp_example(exec_base, run, node.id, seq, fe, process_id=proc.id)
        try:
            proc.status = (ProcessStatus.STOPPED if result.exit_code == 0
                           else ProcessStatus.FAILED).value
            proc.exit_code = result.exit_code
            await proc.update()
        except Exception:
            logger.debug("FlowManager: subprocess row stamp failed", exc_info=True)
        detail = {"duration_ms": duration, "exit_code": result.exit_code,
                  "stdout": result.stdout[-2000:], "stderr": result.stderr[-2000:],
                  "process_id": proc.id}
        if result.exit_code == 0:
            run.journal.append("node_done", {"node": node.id, "execution": {"seq": seq}, **detail})
            # Uniform auto-`done`: the handler's dict return, in both runtimes.
            # Reserve the successor hop BEFORE releasing this slot (counters
            # must never hit 0/0 mid-handoff).
            if isinstance(result.result, dict):
                self.emit_from_node(run, node.id, AGENT_DONE_EVENT, result.result)
            self._finish_execution(run, rt)
            await self._broadcast_node_status(run, node, "finished", detail)
        else:
            self._finish_execution(run, rt)
            run.journal.append("node_error", {"node": node.id, "execution": {"seq": seq}, **detail})
            await self._broadcast_node_status(
                run, node, "failed",
                {**detail, "error": f"exit {result.exit_code}: {result.stderr.strip()[-300:]}"},
            )
        self._maybe_finalize(run)

    async def _attach_to_run(self, run: _Run, proc: Any) -> None:
        try:
            from flow_sdk.builtin.agentic_flow_run import AgenticFlowRun

            row = await AgenticFlowRun.get_by_id(run.id)
            if row is not None:
                await row.attach_child(proc)
        except Exception:
            logger.debug("FlowManager: run→process attach failed", exc_info=True)

    # ── agent execution ───────────────────────────────────────────────────────

    async def _resolve_agent_def(self, node: FlowNodeDef) -> dict[str, Any]:
        """The node's Agent DEFINITION, aligned with trigger→Trigger: when
        ``node_data.typeid`` references an Agent entity, its md (Claude Code
        --agents spec: model, system prompt) is the base — node fields
        override. Purely-inline nodes resolve to an empty definition.

        Raises RuntimeError on a dangling reference — a mistyped/deleted Agent
        must fail the execution loudly, not silently fall back to inline."""
        from flow_sdk.flow_manager.flow_doc import agent_ref

        agent_id = agent_ref(node)
        if not agent_id:
            return {}
        from flow_sdk.builtin.agent import Agent
        from flow_sdk.fs_store.indexer.functions.agent import parse_agent_markdown

        entity = await Agent.get_by_id(agent_id)
        if entity is None or not entity.asset_ref:
            raise RuntimeError(f"agent node {node.id}: Agent {agent_id!r} not found")
        try:
            parsed = parse_agent_markdown(Path(entity.asset_ref).read_text(encoding="utf-8"),
                                          name=entity.name)
        except OSError as e:
            raise RuntimeError(f"agent node {node.id}: Agent md unreadable: {e}") from e
        parsed["agent_id"] = agent_id
        return parsed

    @staticmethod
    def _agent_model(agent_def: dict[str, Any], nd: dict[str, Any]) -> str:
        """CLI model: node ``model_size`` override wins, else the Agent md's
        ``model`` (already a CLI name), else the sm default."""
        from flow_sdk.builtin.flow_node import MODEL_SIZE_TO_CLI

        if nd.get("model_size"):
            return MODEL_SIZE_TO_CLI.get(str(nd["model_size"]), "haiku")
        return str(agent_def.get("model") or "") or "haiku"

    async def _spawn_agent(self, run: _Run, node: FlowNodeDef, fe: RunEvent,
                           rt: _NodeRuntime, seq: int) -> None:
        from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

        cfg = run.flow.doc.config
        if run.processes >= cfg.max_processes:
            self._finish_execution(run, rt)
            self._trip(run, f"max_processes {cfg.max_processes} exhausted")
            return
        run.processes += 1
        nd = node.node_data
        agent_def = await self._resolve_agent_def(node)
        proc = AgenticProcess(
            workdir=nd.get("workdir"),
            visible=bool(nd.get("visible", False)),
            name=f"Flow {run.flow.doc.name or run.flow.flow_id[:8]}: "
                 f"{node.name or agent_def.get('name') or node.id[:8]}",
            cli_config={"model": self._agent_model(agent_def, nd)},
        )
        # Standardized input record in the process's OWN folders (id is minted
        # at construction, so the record dir is known pre-save) — the preamble
        # points the agent at it.
        exec_base = execution_base(proc)
        prepare_execution_io(exec_base, fe)
        instruction = self._agent_instruction(run, node, fe, exec_base, agent_def)
        proc.instruction_content = instruction
        await proc.save()
        await proc.start_pty(instruction=instruction, visible=bool(nd.get("visible", False)))
        await self._attach_to_run(run, proc)
        spawn_row: dict[str, Any] = {"node": node.id, "process_id": proc.id,
                                     "execution": {"seq": seq}}
        if agent_def.get("agent_id"):
            spawn_row["agent_id"] = agent_def["agent_id"]
        run.journal.append("agent_spawn", spawn_row)
        await self._broadcast_node_status(run, node, "started",
                                          {"program_kind": nd.get("program_kind", "instruction"),
                                           "process_id": proc.id})
        asyncio.create_task(self._watch_agent(run, node, proc.id, rt, seq, fe,
                                              agent_id=agent_def.get("agent_id")))

    def _agent_instruction(self, run: _Run, node: FlowNodeDef, fe: RunEvent,
                           exec_base: Path, agent_def: dict[str, Any] | None = None) -> str:
        nd = node.node_data
        prompt = f" {nd.get('prompt')}" if nd.get("prompt") else ""
        base = (
            f"/{nd.get('program_ref')}{prompt}"
            if nd.get("program_kind") == "skill"
            else f"{nd.get('program_ref') or ''}{prompt}"
        )
        # A referenced Agent definition's system prompt (md body) leads; the
        # node's inline program/prompt rides after it as the task addendum.
        definition = str((agent_def or {}).get("prompt") or "")
        if definition:
            base = f"{definition}\n\n{base}" if base.strip() else definition
        preview = json.dumps(fe.data, indent=2, default=str)
        if len(preview) > 2000:
            preview = preview[:2000] + "\n… (truncated — read the input file for the full event)"
        flow_output = run.record_dir / "execution" / "output" / node.id
        context = (
            f"\n\n---\nFlow event `{fe.event}` (flow {run.flow.doc.name or run.flow.flow_id}, "
            f"execution {run.id}).\nData preview:\n```json\n{preview}\n```\n"
            f"Your full input event: `{exec_base / 'input' / 'event.json'}`.\n"
            f"Write any output artifacts to: `{exec_base / 'output'}/`.\n"
            f"Flow-level outputs (results for the whole run) go to: `{flow_output}/`.\n"
            "When you finish, your final answer is emitted automatically as this node's "
            "`done` event — no further action needed."
        )
        return base + context

    async def _watch_agent(self, run: _Run, node: FlowNodeDef, proc_id: str,
                           rt: _NodeRuntime, seq: int, fe: RunEvent,
                           agent_id: str | None = None) -> None:
        """One-shot agent execution: wait for the turn to complete (busy→idle),
        stop the process, auto-emit ``done {output, output_files}``, free the slot."""
        from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
        from flow_sdk.builtin.agentic_process.status_predicates import is_turn_busy
        from flow_sdk.builtin.process_lifecycle import ProcessStatus

        terminal = {ProcessStatus.STOPPED.value, ProcessStatus.FAILED.value}
        seen_busy = False
        started = time.monotonic()
        output = ""
        failed: Optional[str] = None
        exec_base: Optional[Path] = None
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
                exec_base = execution_base(proc)
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
            if exec_base is not None:
                self._stamp_example(exec_base, run, node.id, seq, fe, process_id=proc_id,
                                    agent_id=agent_id)
            if failed:
                self._finish_execution(run, rt)
                run.journal.append("node_error", {"node": node.id, "process_id": proc_id,
                                                  "error": failed, "duration_ms": duration,
                                                  "execution": {"seq": seq}})
                await self._broadcast_node_status(run, node, "failed",
                                                  {"error": failed, "process_id": proc_id,
                                                   "duration_ms": duration})
            else:
                run.journal.append("node_done", {"node": node.id, "process_id": proc_id,
                                                 "duration_ms": duration,
                                                 "execution": {"seq": seq}})
                # Reserve the successor hop (pending += 1, synchronous) BEFORE
                # releasing this execution slot — counters must never hit 0/0
                # mid-handoff or a concurrent finalize could sink the run.
                self.emit_from_node(run, node.id, AGENT_DONE_EVENT,
                                    {"output": output, "process_id": proc_id,
                                     "output_files": self._output_listing(exec_base)})
                self._finish_execution(run, rt)
                await self._broadcast_node_status(run, node, "finished",
                                                  {"duration_ms": duration, "process_id": proc_id})
            await self._drain(run.flow.flow_id, node)
            self._maybe_finalize(run)

    @staticmethod
    def _output_listing(exec_base: Optional[Path]) -> list[str]:
        """Relative listing of the execution's output folder (the artifacts)."""
        if exec_base is None:
            return []
        out = exec_base / "output"
        try:
            return sorted(str(p.relative_to(out)) for p in out.rglob("*") if p.is_file())
        except OSError:
            return []

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

    # ── emissions from nodes ──────────────────────────────────────────────────

    def emit_from_node(self, run: _Run, node_id: str, event: str, data: dict[str, Any]) -> None:
        """SYNC on purpose: the ``pending`` reserve must land before the caller
        releases its execution slot (or returns to the event loop) — counters
        must never hit 0/0 mid-handoff. The hop itself runs as a loop task."""
        fe = RunEvent(event=event, data=data, flow_id=run.flow.flow_id,
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

    # ── rerun ─────────────────────────────────────────────────────────────────

    async def replay_run(self, flow_id: str, run_id: str) -> Optional[str]:
        """Re-inject a past run's ENTRY events into a FRESH run.

        Replay is a real re-execution — side effects re-fire; idempotency is
        the function author's contract. Returns the new run id."""
        input_dir = run_record_dir(run_id) / "execution" / "input"
        entries = sorted(input_dir.glob("event-*.json"),
                         key=lambda p: int(p.stem.split("-")[1]))
        if not entries:
            raise ValueError(f"run {run_id} has no recorded input events")
        new_run_id: Optional[str] = None
        for path in entries:
            payload = json.loads(path.read_text(encoding="utf-8"))
            fe = await self.inject(
                flow_id, str(payload.get("event") or ""), payload.get("data") or {},
                execution_id=new_run_id,
                source_node=str(payload.get("source_node") or EXTERNAL_SOURCE),
                target_node=str(payload.get("target_node") or "") or None,
            )
            if fe is not None:
                new_run_id = fe.execution_id
        return new_run_id

    async def reexecute(self, flow_id: str, run_id: str, seq: int) -> Optional[str]:
        """Re-deliver one past execution's recorded input to its node, in a
        FRESH run — the failed-step debug loop. Returns the new run id."""
        from flow_sdk.flow_manager.journal import read_run_journal

        flow = await self.load_flow(flow_id)
        if flow is None:
            raise ValueError(f"Unknown or unreadable flow: {flow_id}")
        node_id: Optional[str] = None
        process_id: Optional[str] = None
        for entry in read_run_journal(flow.folder, run_id):
            if (entry.get("execution") or {}).get("seq") == seq:
                node_id = str(entry.get("node") or "") or node_id
                process_id = str(entry.get("process_id") or "") or process_id
        if not node_id:
            raise ValueError(f"run {run_id} has no execution seq {seq}")
        if process_id:
            from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

            proc = await AgenticProcess.get_by_id(process_id)
            if proc is None:
                raise ValueError(f"execution process {process_id} no longer exists")
            input_path = execution_base(proc) / "input" / "event.json"
        else:
            input_path = inline_exec_dir(run_id, seq, node_id) / "input" / "event.json"
        try:
            payload = json.loads(input_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            raise ValueError(f"execution input record unavailable: {e}") from e
        fe = await self.inject(
            flow_id, str(payload.get("event") or ""), payload.get("data") or {},
            target_node=node_id,
        )
        return fe.execution_id if fe else None

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
        # The whole RUN is an example too (input = entry events, output = terminals).
        self._stamp_example(run.record_dir / "execution", run, "$run", 0, None)
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
        self._emit_flow_topic(
            run, "done" if status == RunStatus.COMPLETE.value else "failed",
            {"status": status, "events": run.events, "executions": run.executions,
             "error": run.error})
        self._runs.pop(run.id, None)
        try:
            await self._prune_runs(run.flow)
        except Exception:
            logger.exception("FlowManager: run retention prune failed for %s", run.flow.flow_id)

    async def _prune_runs(self, flow: _LoadedFlow) -> None:
        """Enforce ``config.retention_runs``: keep the newest N runs' records.

        Pruned runs lose their row (proper ``destroy``), their child process
        rows (agent + subprocess executions), their record dir, and their
        journal. Promoted dataset examples are copies — immune by construction.
        """
        from flow_sdk.builtin.agentic_flow_run import AgenticFlowRun

        keep = max(0, int(flow.doc.config.retention_runs))
        rows = await AgenticFlowRun.get_all({"flow_id": flow.flow_id})
        rows.sort(key=lambda r: str(r.started_at or ""), reverse=True)
        for row in rows[keep:]:
            if row.id in self._runs:
                continue  # never prune a live run
            try:
                for child in await row.get_children():
                    try:
                        await child.destroy()
                    except Exception:
                        logger.debug("FlowManager: prune child destroy failed", exc_info=True)
            except Exception:
                logger.debug("FlowManager: prune children listing failed", exc_info=True)
            shutil.rmtree(run_record_dir(row.id), ignore_errors=True)
            journal = flow.folder / "runs" / f"{row.id}.jsonl"
            try:
                journal.unlink(missing_ok=True)
            except OSError:
                pass
            try:
                await row.destroy()
            except Exception:
                logger.debug("FlowManager: prune run destroy failed", exc_info=True)
            logger.info("FlowManager: pruned run %s of flow %s (retention %d)",
                        row.id[:8], flow.flow_id[:8], keep)

    # ── observability ─────────────────────────────────────────────────────────

    def _journal_event(self, run: _Run, fe: RunEvent) -> None:
        row: dict[str, Any] = {"event": fe.event, "data": fe.data,
                               "source_node": fe.source_node, "hop": fe.hop,
                               "event_id": fe.id}
        if fe.actor:
            row["actor"] = fe.actor
        run.journal.append("event", row)
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
