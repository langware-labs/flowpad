"""FlowManager — single choke point for flow-graph event routing.

emit() pipeline:
  1. validate + get-or-mint the Topic entity (ancestors minted lazily)
  2. stamp/extend the envelope
  3. enforce per-chain budgets (depth, process count, deadline, cycle check)
  4. resolve listeners: ancestor walk → incoming ``Listens`` edges
  5. dispatch per listener node (callback / spawn / inject)
  6. stamp observed ``Emits`` edge for flow_node sources
  7. journal + WS broadcast

All loop protection lives HERE — listener nodes (especially spawned agents)
are untrusted. Budget trips journal the event with ``dropped`` set and emit a
budget-exempt ``flow.error.protection`` event so strangled flows stay visible.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Optional

from flow_sdk.builtin.agentic_flow import (
    DEFAULT_DEADLINE_S,
    DEFAULT_MAX_DEPTH,
    DEFAULT_MAX_PROCESSES,
    AgenticFlow,
)
from flow_sdk.builtin.flow_node import DeliveryMode, FlowNode, ProgramKind
from flow_sdk.builtin.topic import Topic, is_valid_topic_name
from flow_sdk.db.drivers.query import QueryFilter
from flow_sdk.flow_manager.envelope import TopicEvent
from flow_sdk.flow_manager.journal import FlowJournal
from flow_sdk.flow_manager.matcher import topic_ancestors
from flow_sdk.flowpad_types.enums.entity_enums import (
    BuiltInRelationshipTypes,
    RelationshipDirection,
)

logger = logging.getLogger(__name__)

# Error/protection topics are budget-exempt and never re-dispatched recursively.
PROTECTION_TOPIC = "flow.error.protection"
DEAD_LETTER_PREFIX = "flow.error"

# Cap on how many chains we keep budget state for (stale chains evicted oldest-first).
_MAX_TRACKED_CHAINS = 500


class _ChainState:
    """Per-correlation-chain budget ledger."""

    __slots__ = ("started_at", "processes", "visited", "max_depth", "max_processes", "deadline_s")

    def __init__(self, max_depth: int, max_processes: int, deadline_s: int) -> None:
        self.started_at = time.monotonic()
        self.processes = 0
        # (topic, node_id) delivery pairs seen in this chain — cycle refusal.
        self.visited: set[tuple[str, str]] = set()
        self.max_depth = max_depth
        self.max_processes = max_processes
        self.deadline_s = deadline_s


class _NodeRuntime:
    """Per-node scheduler state: pending events + in-flight execution count."""

    __slots__ = ("queue", "active")

    def __init__(self) -> None:
        from collections import deque

        self.queue: "deque[tuple[TopicEvent, _ChainState]]" = deque()
        self.active = 0


def _event_identity(event: TopicEvent) -> str:
    """Identity key for merge_identical: topic + canonical payload."""
    return f"{event.topic}|{json.dumps(event.payload, sort_keys=True, default=str)}"


# Spawn-execution completion is polled (no push hook on PTY exit today); the
# watcher only runs while a spawned execution is outstanding.
_SPAWN_WATCH_INTERVAL_S = 2.0


class FlowManager:
    def __init__(self) -> None:
        self._chains: dict[str, _ChainState] = {}
        self._journal = FlowJournal()
        # (node_id, topic_name) Emits edges already stamped — avoids re-writing.
        self._stamped_emits: set[tuple[str, str]] = set()
        # Per-node scheduler state (queue + active executions).
        self._runtime: dict[str, _NodeRuntime] = {}
        # Topic names whose entity (and ancestors) are known minted — first
        # emit of a name pays the DB round trips, later emits pay zero.
        self._minted_topics: set[str] = set()

    def _node_runtime(self, node_id: str) -> _NodeRuntime:
        rt = self._runtime.get(node_id)
        if rt is None:
            rt = self._runtime[node_id] = _NodeRuntime()
        return rt

    def runtime_snapshot(self) -> dict[str, dict[str, int]]:
        """Per-node queue depth + in-flight executions (agentic-flows canvas badges)."""
        return {
            node_id: {"queued": len(rt.queue), "active": rt.active}
            for node_id, rt in self._runtime.items()
            if rt.queue or rt.active
        }

    async def _broadcast_node_status(
        self,
        node: FlowNode,
        phase: str,
        event: TopicEvent | None = None,
        detail: dict[str, Any] | None = None,
    ) -> None:
        """Push one scheduler transition to every client (the liveness feed).

        Counts are read AFTER the transition, so the frontend can render
        queue/active without ever consulting the snapshot. No-op when no
        server WS context exists (tests / CLI)."""
        rt = self._node_runtime(node.id or "")
        try:
            from flow_sdk.api.messages import FlowNodeStatusMessage
            from flow_sdk.core.capabilities.models import now_iso
            from flow_sdk.server.routes.websocket import broadcast

            msg = FlowNodeStatusMessage(
                node_id=node.id or "",
                phase=phase,
                queued=len(rt.queue),
                active=rt.active,
                event_topic=event.topic if event else "",
                correlation_id=event.correlation_id if event else "",
                detail=detail or {},
                ts=now_iso(),
            )
            await broadcast(msg.model_dump_json())
        except Exception:
            logger.debug("FlowManager: node-status broadcast unavailable", exc_info=True)

    # ── public API ────────────────────────────────────────────────────────────

    async def emit(self, event: TopicEvent) -> TopicEvent:
        """Route one event through the graph. Returns the (journal-stamped) event."""
        if not is_valid_topic_name(event.topic):
            raise ValueError(f"Invalid topic name: {event.topic!r}")

        # One boundary load per emit; membership becomes a dict lookup for
        # every listener (was a full AgenticFlow scan per listener).
        boundaries = await self._load_boundaries()
        chain = await self._chain_for(event, boundaries)

        # ── budgets (control events exempt) ───────────────────────────────────
        if not event.control:
            drop = self._budget_check(event, chain)
            if drop:
                event.dropped = drop
                await self._journal_and_broadcast(event)
                await self._emit_protection(event, drop)
                return event

        # Mint the topic (and its ancestors) so the prefix tree is real.
        await self._mint_with_ancestors(event.topic)

        # Observed Emits edge for flow_node sources.
        await self._stamp_emit_edge(event)

        await self._journal_and_broadcast(event)

        # ── resolve listeners along the ancestor chain ────────────────────────
        listeners = await self._resolve_listeners(event.topic)
        for node in listeners:
            if not node.enabled:
                continue
            key = (event.topic, node.id or "")
            if key in chain.visited and not event.control:
                logger.info("FlowManager: cycle refusal — %s already delivered to %s", *key)
                continue
            chain.visited.add(key)
            boundary = boundaries.get(node.id or "")
            if boundary is not None and not boundary.enabled:
                continue
            await self._deliver(node, event, chain)
        return event

    async def emit_named(
        self,
        topic: str,
        payload: dict[str, Any] | None = None,
        *,
        source: str = "manual",
        parent: TopicEvent | None = None,
        scope: str | None = None,
    ) -> TopicEvent:
        """Convenience: build the envelope (extending ``parent`` if given) and emit."""
        if parent is not None:
            event = parent.child(topic, payload or {}, source=source)
        else:
            event = TopicEvent(topic=topic, payload=payload or {}, source=source, scope=scope)
        return await self.emit(event)

    def journal_tail(self, limit: int = 200, correlation_id: str | None = None) -> list[dict[str, Any]]:
        return self._journal.tail(limit=limit, correlation_id=correlation_id)

    # ── graph snapshot (agentic-flows bootstrap) ─────────────────────────────────────

    async def graph_snapshot(self) -> dict[str, Any]:
        """Everything the agentic-flows canvas needs in one payload."""
        topics = await Topic.get_all({})
        nodes = await FlowNode.get_all({})
        graphs = await AgenticFlow.get_all({})
        edges: list[dict[str, Any]] = []
        topic_by_id = {t.id: t for t in topics}
        for node in nodes:
            for rel_type in (BuiltInRelationshipTypes.Listens, BuiltInRelationshipTypes.Emits):
                rels = await node.get_outgoing_relationships(
                    relationships_filter=QueryFilter(type=rel_type)
                )
                for rel in rels:
                    if rel.to_typeid and rel.to_typeid.id in topic_by_id:
                        edges.append(
                            {
                                "kind": rel_type.value,
                                "node_id": node.id,
                                "topic_id": rel.to_typeid.id,
                                "topic": topic_by_id[rel.to_typeid.id].name,
                            }
                        )
        return {
            "topics": [t.model_dump(mode="json", include={"id", "name", "description", "color"}) for t in topics],
            "nodes": [
                n.model_dump(
                    mode="json",
                    include={
                        "id", "name", "description", "program_kind", "program_ref",
                        "prompt", "model_size",
                        "delivery_mode", "workdir", "enabled", "current_process_id",
                        "execution_mode", "parallel_limit", "merge_identical",
                    },
                )
                for n in nodes
            ],
            "agentic_flows": [
                g.model_dump(
                    mode="json",
                    include={
                        "id", "name", "enabled", "member_node_ids",
                        "max_depth", "max_processes", "deadline_s",
                    },
                )
                for g in graphs
            ],
            "edges": edges,
        }

    # ── internals ─────────────────────────────────────────────────────────────

    async def _load_boundaries(self) -> dict[str, AgenticFlow]:
        """Load flow boundaries once and index by member node id."""
        by_node: dict[str, AgenticFlow] = {}
        for g in await AgenticFlow.get_all({}):
            for node_id in g.member_node_ids or []:
                by_node[node_id] = g
        return by_node

    async def _chain_for(self, event: TopicEvent, boundaries: dict[str, AgenticFlow]) -> _ChainState:
        chain = self._chains.get(event.correlation_id)
        if chain is None:
            budget = await self._root_budget(event, boundaries)
            chain = _ChainState(*budget)
            if len(self._chains) >= _MAX_TRACKED_CHAINS:
                oldest = min(self._chains, key=lambda k: self._chains[k].started_at)
                self._chains.pop(oldest, None)
            self._chains[event.correlation_id] = chain
        return chain

    async def _root_budget(
        self, event: TopicEvent, boundaries: dict[str, AgenticFlow]
    ) -> tuple[int, int, int]:
        """Budget for a fresh chain: the source node's boundary if it has one,
        router defaults otherwise."""
        node = await self._source_node(event)
        if node is not None:
            boundary = boundaries.get(node.id or "")
            if boundary is not None:
                return boundary.max_depth, boundary.max_processes, boundary.deadline_s
        return DEFAULT_MAX_DEPTH, DEFAULT_MAX_PROCESSES, DEFAULT_DEADLINE_S

    def _budget_check(self, event: TopicEvent, chain: _ChainState) -> Optional[str]:
        if event.depth > chain.max_depth:
            return f"depth {event.depth} > max_depth {chain.max_depth}"
        if time.monotonic() - chain.started_at > chain.deadline_s:
            return f"chain deadline {chain.deadline_s}s exceeded"
        return None

    def _charge_process(self, chain: _ChainState) -> Optional[str]:
        if chain.processes >= chain.max_processes:
            return f"max_processes {chain.max_processes} exhausted for chain"
        chain.processes += 1
        return None

    async def _mint_with_ancestors(self, topic_name: str) -> None:
        if topic_name in self._minted_topics:
            return
        for ancestor in topic_ancestors(topic_name):
            if ancestor not in self._minted_topics:
                await Topic.get_or_mint(ancestor)
                self._minted_topics.add(ancestor)

    async def _source_node(self, event: TopicEvent) -> Optional[FlowNode]:
        if ":" not in event.source:
            return None
        type_part, _, id_part = event.source.partition(":")
        if type_part != "flow_node":
            return None
        return await FlowNode.get_by_id(id_part)

    async def _stamp_emit_edge(self, event: TopicEvent) -> None:
        node = await self._source_node(event)
        if node is None or not node.id:
            return
        key = (node.id, event.topic)
        if key in self._stamped_emits:
            return
        topic = await Topic.get_or_mint(event.topic)
        existing = await node.get_outgoing_relationships(
            relationships_filter=QueryFilter(type=BuiltInRelationshipTypes.Emits)
        )
        if not any(rel.to_typeid and rel.to_typeid.id == topic.id for rel in existing):
            await node.save_relationship(
                to_e=topic.typeid,
                relationship_or_str=BuiltInRelationshipTypes.Emits,
                direction=RelationshipDirection.Outgoing,
            )
        self._stamped_emits.add(key)

    async def _resolve_listeners(self, topic_name: str) -> list[FlowNode]:
        """Ancestor walk: listeners on any prefix of ``topic_name`` hear it."""
        seen: dict[str, FlowNode] = {}
        from flow_sdk.builtin.topic import topic_entity_id

        for ancestor in topic_ancestors(topic_name):
            topic = await Topic.get_by_id(topic_entity_id(ancestor))
            if topic is None:
                continue
            rels = await topic.get_incoming_relationships(
                relationships_filter=QueryFilter(type=BuiltInRelationshipTypes.Listens)
            )
            for rel in rels:
                if rel.from_typeid and rel.from_typeid.id not in seen:
                    node = await FlowNode.get_by_id(rel.from_typeid.id)
                    if node:
                        seen[node.id] = node
        return list(seen.values())

    # ── delivery scheduler (queue + serial/parallel drain) ───────────────────

    async def _deliver(self, node: FlowNode, event: TopicEvent, chain: _ChainState) -> None:
        """Enqueue an event for a node (merge-identical aware), then drain."""
        rt = self._node_runtime(node.id or "")
        if node.merge_identical:
            identity = _event_identity(event)
            if any(_event_identity(pending) == identity for pending, _ in rt.queue):
                logger.info("FlowManager: merged identical event %s into pending queue of %s",
                            event.topic, node.name)
                await self._broadcast_node_status(node, "merged", event)
                return
        rt.queue.append((event, chain))
        await self._broadcast_node_status(node, "queued", event)
        await self._drain(node)

    def _execution_limit(self, node: FlowNode) -> int:
        from flow_sdk.builtin.flow_node import ExecutionMode

        if node.execution_mode == ExecutionMode.PARALLEL.value:
            return max(1, int(node.parallel_limit or 1))
        return 1

    async def _drain(self, node: FlowNode) -> None:
        """Run pending events up to the node's concurrency limit.

        Callback/inject executions complete inline (awaited), so serial
        callback nodes process their whole queue before this returns — which
        keeps in-process flows deterministic. Spawn executions stay "active"
        until the spawned process reaches a terminal status (watcher task),
        so a serial spawn node runs its agents strictly one at a time.
        """
        rt = self._node_runtime(node.id or "")
        limit = self._execution_limit(node)
        while rt.queue and rt.active < limit:
            event, chain = rt.queue.popleft()
            rt.active += 1
            try:
                await self._execute(node, event, chain, rt)
            except Exception as e:
                rt.active -= 1
                logger.exception("FlowManager: listener %s failed for %s", node.name, event.topic)
                await self._broadcast_node_status(node, "failed", event, {"error": str(e)})
                await self._emit_dead_letter(event, node)

    async def _run_inline(
        self,
        node: FlowNode,
        event: TopicEvent,
        rt: _NodeRuntime,
        kind: str,
        dispatch: Any,
    ) -> None:
        """An execution that completes within this call (callback / inject):
        started → dispatch → slot freed → finished(duration)."""
        await self._broadcast_node_status(node, "started", event, {"program_kind": kind})
        started = time.monotonic()
        try:
            await dispatch(node, event)
        finally:
            rt.active -= 1
        await self._broadcast_node_status(
            node, "finished", event,
            {"duration_ms": int((time.monotonic() - started) * 1000)},
        )

    async def _execute(self, node: FlowNode, event: TopicEvent, chain: _ChainState, rt: _NodeRuntime) -> None:
        if node.program_kind == ProgramKind.CALLBACK.value:
            await self._run_inline(node, event, rt, "callback", self._dispatch_callback)
        elif node.delivery_mode == DeliveryMode.INJECT.value:
            await self._run_inline(node, event, rt, "inject", self._dispatch_inject)
        else:
            drop = self._charge_process(chain)
            if drop:
                rt.active -= 1
                event_copy = event.model_copy(update={"dropped": drop})
                await self._journal_and_broadcast(event_copy)
                await self._broadcast_node_status(node, "failed", event, {"error": drop})
                await self._emit_protection(event, drop)
                return
            try:
                proc_id = await self._dispatch_spawn(node, event)
            except Exception as e:
                rt.active -= 1
                await self._broadcast_node_status(node, "failed", event, {"error": str(e)})
                raise
            await self._broadcast_node_status(
                node, "started", event,
                {"program_kind": node.program_kind, "process_id": proc_id},
            )
            # Occupy the slot until the spawned process terminates.
            asyncio.create_task(self._watch_spawn(node, proc_id, rt, event))

    async def _watch_spawn(
        self, node: FlowNode, proc_id: str, rt: _NodeRuntime, event: TopicEvent | None = None
    ) -> None:
        """Poll a spawned execution until its ONE turn completes, then stop the
        process (flow spawns are one-shot — a lingering idle PTY would hold the
        node's slot forever) and free the slot. Interval is a scheduler
        heartbeat, not a wait-for-symptom timeout; it only runs while a slot is
        held. Completion = turn observed busy → idle (or terminal status)."""
        from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
        from flow_sdk.builtin.agentic_process.status_predicates import is_turn_busy
        from flow_sdk.builtin.process_lifecycle import ProcessStatus

        terminal = {ProcessStatus.STOPPED.value, ProcessStatus.FAILED.value}
        seen_busy = False
        started = time.monotonic()
        outcome: tuple[str, dict[str, Any]] = ("finished", {"process_id": proc_id})
        try:
            while True:
                await asyncio.sleep(_SPAWN_WATCH_INTERVAL_S)
                proc = await AgenticProcess.get_by_id(proc_id)
                if proc is None or proc.status in terminal:
                    if proc is not None and proc.status == ProcessStatus.FAILED.value:
                        outcome = ("failed", {"process_id": proc_id,
                                              "error": proc.start_failure or "process failed"})
                    return
                busy = is_turn_busy(proc)
                if busy:
                    seen_busy = True
                elif seen_busy:
                    # Turn ran and finished — one-shot execution complete.
                    try:
                        await proc.exit()
                    except Exception:
                        logger.exception("FlowManager: one-shot exit failed for %s", proc_id)
                    return
        except Exception:
            logger.exception("FlowManager: spawn watcher failed for node %s", node.name)
            outcome = ("failed", {"process_id": proc_id, "error": "spawn watcher failed"})
        finally:
            rt.active -= 1
            phase, detail = outcome
            detail["duration_ms"] = int((time.monotonic() - started) * 1000)
            await self._broadcast_node_status(node, phase, event, detail)
            await self._broadcast_node_status(node, "slot_freed", event, {"process_id": proc_id})
            try:
                await self._drain(node)
            except Exception:
                logger.exception("FlowManager: post-spawn drain failed for node %s", node.name)

    async def _dispatch_callback(self, node: FlowNode, event: TopicEvent) -> None:
        from flow_sdk.builtin import trigger_callbacks

        fn = trigger_callbacks.get(node.program_ref)
        if fn is None:
            raise RuntimeError(f"No registered callback {node.program_ref!r}")
        result = fn(event)
        if asyncio.iscoroutine(result):
            await result

    @staticmethod
    def _emit_url() -> str:
        """Full emit endpoint of THIS instance, for spawned agents (they have
        no SDK — they curl). Port comes from the instance's server.json."""
        try:
            from flow_sdk.instance_settings import get_instance_settings

            data = json.loads(get_instance_settings().server_json_path.read_text())
            return f"http://localhost:{data['port']}/api/v1/topics/emit"
        except Exception:
            return "/api/v1/topics/emit"

    def _instruction_for(self, node: FlowNode, event: TopicEvent) -> str:
        context = (
            f"\n\n---\nFlow event on topic `{event.topic}` "
            f"(correlation_id: {event.correlation_id}, depth: {event.depth}).\n"
            f"Payload:\n```json\n{json.dumps(event.payload, indent=2)}\n```\n"
            f"To emit a follow-on topic event, run:\n"
            f"curl -s -X POST {self._emit_url()} -H 'Content-Type: application/json' "
            f"-d '{{\"topic\": \"<name>\", \"payload\": {{...}}, \"envelope\": "
            f'{{"correlation_id": "{event.correlation_id}", "depth": {event.depth + 1}, '
            f'"source": "flow_node:{node.id}"}}}}\''
        )
        prompt = f" {node.prompt}" if node.prompt else ""
        if node.program_kind == ProgramKind.SKILL.value:
            return f"/{node.program_ref}{prompt}{context}"
        return f"{node.program_ref}{prompt}{context}"

    async def _dispatch_spawn(self, node: FlowNode, event: TopicEvent) -> str:
        from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

        from flow_sdk.builtin.flow_node import MODEL_SIZE_TO_CLI

        instruction = self._instruction_for(node, event)
        proc = AgenticProcess(
            instruction_content=instruction,
            workdir=node.workdir,
            visible=node.visible,
            name=f"FlowNode: {node.name or node.program_ref}",
            cli_config={"model": MODEL_SIZE_TO_CLI.get(node.model_size or "sm", "haiku")},
        )
        await proc.save()
        await proc.start_pty(instruction=instruction, visible=node.visible)
        logger.info("FlowManager: spawned %s for node %s on %s", proc.id, node.name, event.topic)
        return proc.id

    async def _dispatch_inject(self, node: FlowNode, event: TopicEvent) -> None:
        from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

        if not node.current_process_id:
            await self._emit_dead_letter(event, node, reason="inject node has no current_process_id")
            return
        proc = await AgenticProcess.get_by_id(node.current_process_id)
        if proc is None:
            await self._emit_dead_letter(event, node, reason="inject target process not found")
            return
        await proc.prompt(self._instruction_for(node, event))

    # ── error/protection topics (budget-exempt, non-recursive) ────────────────

    async def _emit_protection(self, event: TopicEvent, reason: str) -> None:
        await self._safe_meta_emit(
            event, PROTECTION_TOPIC, {"reason": reason, "refused_topic": event.topic}
        )

    async def _emit_dead_letter(self, event: TopicEvent, node: FlowNode, reason: str = "listener failed") -> None:
        await self._safe_meta_emit(
            event,
            f"{DEAD_LETTER_PREFIX}.{event.topic}",
            {"reason": reason, "node_id": node.id, "node_name": node.name},
        )

    async def _safe_meta_emit(self, parent: TopicEvent, topic: str, payload: dict[str, Any]) -> None:
        if parent.control:
            return  # control events never spawn further control events
        try:
            event = parent.child(topic, payload, source="flow_manager")
            event.control = True
            await self.emit(event)
        except Exception:
            logger.exception("FlowManager: meta-emit failed for %s", topic)

    # ── journal + broadcast ───────────────────────────────────────────────────

    async def _journal_and_broadcast(self, event: TopicEvent) -> None:
        entry = event.model_dump(mode="json")
        self._journal.append(entry)
        try:
            from flow_sdk.api.messages import TopicEventMessage
            from flow_sdk.server.routes.websocket import broadcast

            await broadcast(TopicEventMessage(event=entry).model_dump_json())
        except Exception:
            # No server context (tests / CLI) — journal-only is fine.
            logger.debug("FlowManager: WS broadcast unavailable", exc_info=True)


_manager: Optional[FlowManager] = None


def get_flow_manager() -> FlowManager:
    global _manager
    if _manager is None:
        _manager = FlowManager()
    return _manager
