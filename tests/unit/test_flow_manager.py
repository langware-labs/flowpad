"""FlowManager unit tests — matcher, topic minting, wiring resolution,
budgets, observed-emit stamping, callback dispatch. All in-process (no PTY
spawns: spawn-path budget tests use a zero budget so the charge refuses before
any process is created)."""
import pytest

from flow_sdk.builtin import trigger_callbacks
from flow_sdk.builtin.agentic_flow import AgenticFlow
from flow_sdk.builtin.flow_node import DeliveryMode, FlowNode, ProgramKind
from flow_sdk.builtin.topic import Topic, is_valid_topic_name, topic_entity_id
from flow_sdk.db.drivers.query import QueryFilter
from flow_sdk.flow_manager import FlowManager, TopicEvent, topic_ancestors, topic_matches
from flow_sdk.flow_manager.manager import PROTECTION_TOPIC
from flow_sdk.flowpad_types.enums.entity_enums import BuiltInRelationshipTypes
from tests.conftest import async_context


@pytest.fixture(autouse=True)
def _journal_to_tmp(tmp_path, monkeypatch):
    """Keep journal writes out of the real instance's records_root."""
    import flow_sdk.flow_manager.journal as journal_mod

    monkeypatch.setattr(journal_mod, "_journal_file", lambda: tmp_path / "events.jsonl")


# ── matcher (pure) ────────────────────────────────────────────────────────────


def test_topic_matches_prefix_any_depth():
    assert topic_matches("a", "a")
    assert topic_matches("a", "a.b.c")
    assert topic_matches("a.b", "a.b.c")
    assert not topic_matches("a.b", "a.bc")
    assert not topic_matches("a.b.c", "a.b")


def test_topic_ancestors():
    assert topic_ancestors("a") == ["a"]
    assert topic_ancestors("report.usage.ready") == ["report", "report.usage", "report.usage.ready"]


def test_topic_name_grammar():
    assert is_valid_topic_name("report.usage.ready")
    assert is_valid_topic_name("flow-node_1.x")
    for bad in ("", "a..b", ".a", "a.", "A.b", "a b", "a.#"):
        assert not is_valid_topic_name(bad), bad


# ── topic minting ─────────────────────────────────────────────────────────────


@async_context
async def test_topic_get_or_mint_idempotent():
    t1 = await Topic.get_or_mint("flowtest.mint.one")
    t2 = await Topic.get_or_mint("flowtest.mint.one")
    assert t1.id == t2.id == topic_entity_id("flowtest.mint.one")


@async_context
async def test_emit_mints_ancestor_chain():
    fm = FlowManager()
    await fm.emit(TopicEvent(topic="flowtest.chain.deep.leaf"))
    for name in topic_ancestors("flowtest.chain.deep.leaf"):
        assert await Topic.get_by_id(topic_entity_id(name)) is not None, name


# ── listener resolution + callback dispatch ──────────────────────────────────


@async_context
async def test_prefix_listener_hears_subtree():
    received: list[TopicEvent] = []

    @trigger_callbacks.register("flowtest_prefix_cb")
    def _cb(event: TopicEvent):
        received.append(event)

    node = FlowNode(name="prefix-listener", program_kind=ProgramKind.CALLBACK.value,
                    program_ref="flowtest_prefix_cb")
    await node.save()
    await node.listen(await Topic.get_or_mint("flowtest.sub"))

    fm = FlowManager()
    await fm.emit(TopicEvent(topic="flowtest.sub.leaf.deep"))
    assert [e.topic for e in received] == ["flowtest.sub.leaf.deep"]
    # Sibling subtree is NOT heard.
    await fm.emit(TopicEvent(topic="flowtest.other"))
    assert len(received) == 1


@async_context
async def test_disabled_node_not_dispatched():
    received: list[TopicEvent] = []

    @trigger_callbacks.register("flowtest_disabled_cb")
    def _cb(event: TopicEvent):
        received.append(event)

    node = FlowNode(name="off", program_kind=ProgramKind.CALLBACK.value,
                    program_ref="flowtest_disabled_cb", enabled=False)
    await node.save()
    await node.listen(await Topic.get_or_mint("flowtest.off"))
    await FlowManager().emit(TopicEvent(topic="flowtest.off.x"))
    assert received == []


@async_context
async def test_unlisten_removes_edge():
    """unlisten deletes the Listens edge (typed relationship — a generic
    Relationship(type=...) deletes as class-type 'relationship' and matches
    nothing; regression for the FlowStudio unwire bug)."""
    node = FlowNode(name="unwire-me", program_kind=ProgramKind.CALLBACK.value, program_ref="nop")
    await node.save()
    topic = await Topic.get_or_mint("flowtest.unwire")
    await node.listen(topic)
    assert [t.id for t in await node.listened_topics()] == [topic.id]
    await node.unlisten(topic)
    assert await node.listened_topics() == []


# ── observed Emits edge ───────────────────────────────────────────────────────


@async_context
async def test_emit_edge_stamped_for_flow_node_source():
    node = FlowNode(name="emitter", program_kind=ProgramKind.CALLBACK.value, program_ref="nop")
    await node.save()
    fm = FlowManager()
    await fm.emit(TopicEvent(topic="flowtest.emits.seen", source=f"flow_node:{node.id}"))
    rels = await node.get_outgoing_relationships(
        relationships_filter=QueryFilter(type=BuiltInRelationshipTypes.Emits)
    )
    topic_id = topic_entity_id("flowtest.emits.seen")
    assert any(r.to_typeid and r.to_typeid.id == topic_id for r in rels)
    # Second emit is a no-op (stamp cache) — no duplicate edges.
    await fm.emit(TopicEvent(topic="flowtest.emits.seen", source=f"flow_node:{node.id}"))
    rels2 = await node.get_outgoing_relationships(
        relationships_filter=QueryFilter(type=BuiltInRelationshipTypes.Emits)
    )
    assert len([r for r in rels2 if r.to_typeid and r.to_typeid.id == topic_id]) == len(
        [r for r in rels if r.to_typeid and r.to_typeid.id == topic_id]
    )


# ── budgets ───────────────────────────────────────────────────────────────────


@async_context
async def test_depth_budget_drops_event():
    received: list[TopicEvent] = []

    @trigger_callbacks.register("flowtest_depth_cb")
    def _cb(event: TopicEvent):
        received.append(event)

    node = FlowNode(name="deep-listener", program_kind=ProgramKind.CALLBACK.value,
                    program_ref="flowtest_depth_cb")
    await node.save()
    await node.listen(await Topic.get_or_mint("flowtest.depth"))

    fm = FlowManager()
    routed = await fm.emit(TopicEvent(topic="flowtest.depth.x", depth=99))
    assert routed.dropped and "depth" in routed.dropped
    assert received == []
    # Protection event journaled (budget-exempt).
    topics_in_journal = [e["topic"] for e in fm.journal_tail(limit=50)]
    assert PROTECTION_TOPIC in topics_in_journal


@async_context
async def test_cycle_refusal_stops_ping_pong():
    """A callback that re-emits its own topic as a child event must not loop:
    the (topic, node) pair is refused on the second delivery."""
    fm = FlowManager()
    count = {"n": 0}

    @trigger_callbacks.register("flowtest_cycle_cb")
    async def _cb(event: TopicEvent):
        count["n"] += 1
        await fm.emit(event.child("flowtest.cycle.x", source="flow_manager_test"))

    node = FlowNode(name="cycler", program_kind=ProgramKind.CALLBACK.value,
                    program_ref="flowtest_cycle_cb")
    await node.save()
    await node.listen(await Topic.get_or_mint("flowtest.cycle"))

    await fm.emit(TopicEvent(topic="flowtest.cycle.x"))
    assert count["n"] == 1  # second delivery refused, no infinite loop


@async_context
async def test_spawn_budget_refuses_before_spawning():
    """max_processes=0 boundary: the spawn charge refuses before any
    AgenticProcess is created; a protection event lands in the journal."""
    node = FlowNode(name="spawny", program_kind=ProgramKind.INSTRUCTION.value,
                    program_ref="echo hi", delivery_mode=DeliveryMode.SPAWN.value)
    await node.save()
    await node.listen(await Topic.get_or_mint("flowtest.spawncap"))
    boundary = AgenticFlow(name="tight", member_node_ids=[node.id], max_processes=0)
    await boundary.save()

    fm = FlowManager()
    # Root the chain at the node so the boundary budget applies.
    await fm.emit(TopicEvent(topic="flowtest.spawncap.go", source=f"flow_node:{node.id}"))
    entries = fm.journal_tail(limit=50)
    assert any(e["topic"] == PROTECTION_TOPIC and "max_processes" in (e["payload"].get("reason") or "")
               for e in entries)


@async_context
async def test_disabled_boundary_blocks_members():
    received: list[TopicEvent] = []

    @trigger_callbacks.register("flowtest_boundary_cb")
    def _cb(event: TopicEvent):
        received.append(event)

    node = FlowNode(name="bounded", program_kind=ProgramKind.CALLBACK.value,
                    program_ref="flowtest_boundary_cb")
    await node.save()
    await node.listen(await Topic.get_or_mint("flowtest.bounded"))
    boundary = AgenticFlow(name="off-boundary", member_node_ids=[node.id], enabled=False)
    await boundary.save()

    await FlowManager().emit(TopicEvent(topic="flowtest.bounded.x"))
    assert received == []


# ── runtime status push (liveness feed) ──────────────────────────────────────


@async_context
async def test_node_status_phase_sequence_serial():
    """The scheduler broadcasts queued→started→finished per delivery, with
    post-transition counts; a gated serial pair interleaves as
    q(1,0) s(0,1) q(1,1) f(0,0)+drain s(0,1) f(0,0)."""
    import asyncio

    fm = FlowManager()
    phases: list[tuple[str, int, int]] = []

    async def _capture(node, phase, event=None, detail=None):
        phases.append((phase, len(fm._node_runtime(node.id).queue),
                       fm._node_runtime(node.id).active))

    fm._broadcast_node_status = _capture  # type: ignore[method-assign]
    gate: asyncio.Event = asyncio.Event()

    @trigger_callbacks.register("flowtest_status_cb")
    async def _cb(event: TopicEvent):
        await gate.wait()

    node = FlowNode(name="status-node", program_kind=ProgramKind.CALLBACK.value,
                    program_ref="flowtest_status_cb", execution_mode="serial")
    await node.save()
    await node.listen(await Topic.get_or_mint("flowtest.status"))

    first = asyncio.ensure_future(fm.emit(TopicEvent(topic="flowtest.status.x", payload={"n": 1})))
    await _until(lambda: ("started", 0, 1) in phases, "first started")
    second = asyncio.ensure_future(fm.emit(TopicEvent(topic="flowtest.status.x", payload={"n": 2})))
    await _until(lambda: ("queued", 1, 1) in phases, "second queued behind running first")
    gate.set()
    await asyncio.gather(first, second)
    assert [p for p, *_ in phases] == [
        "queued", "started", "queued", "finished", "started", "finished",
    ]
    # Final transition leaves the node fully idle.
    assert phases[-1] == ("finished", 0, 0)


@async_context
async def test_node_status_merged_phase():
    import asyncio

    fm = FlowManager()
    phases: list[str] = []

    async def _capture(node, phase, event=None, detail=None):
        phases.append(phase)

    fm._broadcast_node_status = _capture  # type: ignore[method-assign]
    gate: asyncio.Event = asyncio.Event()

    @trigger_callbacks.register("flowtest_status_merge_cb")
    async def _cb(event: TopicEvent):
        await gate.wait()

    node = FlowNode(name="status-merge", program_kind=ProgramKind.CALLBACK.value,
                    program_ref="flowtest_status_merge_cb", execution_mode="serial",
                    merge_identical=True)
    await node.save()
    await node.listen(await Topic.get_or_mint("flowtest.statusmerge"))

    first = asyncio.ensure_future(fm.emit(TopicEvent(topic="flowtest.statusmerge.x", payload={"v": 1})))
    await _until(lambda: "started" in phases, "first started")
    await fm.emit(TopicEvent(topic="flowtest.statusmerge.x", payload={"v": 2}))
    await fm.emit(TopicEvent(topic="flowtest.statusmerge.x", payload={"v": 2}))  # duplicate
    assert phases.count("merged") == 1
    gate.set()
    await first


# ── agent program: skill + prompt + model size ────────────────────────────────


def test_instruction_includes_skill_prompt_and_emit_curl():
    from flow_sdk.builtin.flow_node import MODEL_SIZE_TO_CLI

    fm = FlowManager()
    node = FlowNode(id="n1", name="summarizer", program_kind=ProgramKind.SKILL.value,
                    program_ref="flow-summarize", prompt="keep it under 10 words")
    event = TopicEvent(topic="demo.text.submitted", payload={"text": "hello"})
    instruction = fm._instruction_for(node, event)
    assert instruction.startswith("/flow-summarize keep it under 10 words")
    assert "demo.text.submitted" in instruction
    assert "curl -s -X POST" in instruction and "/api/v1/topics/emit" in instruction
    assert f'"correlation_id": "{event.correlation_id}"' in instruction
    # Model size mapping: sm default → haiku; md/lg map up.
    assert MODEL_SIZE_TO_CLI[node.model_size] == "haiku"
    assert MODEL_SIZE_TO_CLI["md"] == "sonnet" and MODEL_SIZE_TO_CLI["lg"] == "opus"


# ── dead-letter on listener failure ──────────────────────────────────────────


# ── scheduler: serial / parallel / queue / merge ──────────────────────────────


async def _until(cond, what: str = "condition") -> None:
    """Yield until ``cond()`` is true (bounded, sub-second in practice)."""
    import asyncio

    for _ in range(400):
        if cond():
            return
        await asyncio.sleep(0.005)
    raise AssertionError(f"never reached: {what}")


@async_context
async def test_serial_node_executes_one_by_one():
    """Two overlapping deliveries to a serial node run sequentially — the
    second waits in the queue until the first callback completes."""
    import asyncio

    fm = FlowManager()
    order: list[str] = []
    gate: asyncio.Event = asyncio.Event()

    @trigger_callbacks.register("flowtest_serial_cb")
    async def _cb(event: TopicEvent):
        order.append(f"start:{event.payload['n']}")
        if event.payload["n"] == 1:
            await gate.wait()
        order.append(f"end:{event.payload['n']}")

    node = FlowNode(name="serial", program_kind=ProgramKind.CALLBACK.value,
                    program_ref="flowtest_serial_cb", execution_mode="serial")
    await node.save()
    await node.listen(await Topic.get_or_mint("flowtest.serial"))

    first = asyncio.ensure_future(fm.emit(TopicEvent(topic="flowtest.serial.x", payload={"n": 1})))
    await _until(lambda: order == ["start:1"], "first execution started")
    second = asyncio.ensure_future(fm.emit(TopicEvent(topic="flowtest.serial.x", payload={"n": 2})))
    await _until(lambda: fm.runtime_snapshot().get(node.id, {}).get("queued") == 1,
                 "second event queued")
    # Second event must be queued, not started.
    assert order == ["start:1"]
    gate.set()
    await asyncio.gather(first, second)
    assert order == ["start:1", "end:1", "start:2", "end:2"]


@async_context
async def test_parallel_node_respects_limit():
    """parallel_limit=2: two executions run concurrently, the third queues."""
    import asyncio

    fm = FlowManager()
    started: list[int] = []
    gate: asyncio.Event = asyncio.Event()

    @trigger_callbacks.register("flowtest_parallel_cb")
    async def _cb(event: TopicEvent):
        started.append(event.payload["n"])
        await gate.wait()

    node = FlowNode(name="par", program_kind=ProgramKind.CALLBACK.value,
                    program_ref="flowtest_parallel_cb",
                    execution_mode="parallel", parallel_limit=2)
    await node.save()
    await node.listen(await Topic.get_or_mint("flowtest.par"))

    futs = [asyncio.ensure_future(fm.emit(TopicEvent(topic="flowtest.par.x", payload={"n": i})))
            for i in range(3)]
    await _until(lambda: fm.runtime_snapshot().get(node.id) == {"active": 2, "queued": 1},
                 "two in flight + one queued")
    # Concurrent-emit arrival order isn't guaranteed — assert the CONCURRENCY,
    # not which two events won the slots.
    assert len(started) == 2
    gate.set()
    await asyncio.gather(*futs)
    await _until(lambda: sorted(started) == [0, 1, 2], "queued third event drained")


@async_context
async def test_merge_identical_drops_duplicate_pending():
    """merge_identical: an identical event already waiting in the queue absorbs
    the newcomer; a different payload still queues."""
    import asyncio

    fm = FlowManager()
    runs: list[dict] = []
    gate: asyncio.Event = asyncio.Event()

    @trigger_callbacks.register("flowtest_merge_cb")
    async def _cb(event: TopicEvent):
        runs.append(event.payload)
        await gate.wait()

    node = FlowNode(name="merger", program_kind=ProgramKind.CALLBACK.value,
                    program_ref="flowtest_merge_cb", execution_mode="serial",
                    merge_identical=True)
    await node.save()
    await node.listen(await Topic.get_or_mint("flowtest.merge"))

    # v=1 occupies the serial slot (blocked on the gate)...
    first = asyncio.ensure_future(fm.emit(TopicEvent(topic="flowtest.merge.x", payload={"v": 1})))
    await _until(lambda: runs == [{"v": 1}], "first execution started")
    # ...then deliver the rest sequentially: these emits return once queued.
    await fm.emit(TopicEvent(topic="flowtest.merge.x", payload={"v": 2}))
    await fm.emit(TopicEvent(topic="flowtest.merge.x", payload={"v": 2}))  # merged away
    await fm.emit(TopicEvent(topic="flowtest.merge.x", payload={"v": 3}))
    assert fm.runtime_snapshot()[node.id] == {"active": 1, "queued": 2}
    gate.set()
    await first
    await _until(lambda: [r["v"] for r in runs] == [1, 2, 3], "distinct payloads ran once each")


@async_context
async def test_failing_listener_emits_dead_letter():
    @trigger_callbacks.register("flowtest_boom_cb")
    def _cb(event: TopicEvent):
        raise RuntimeError("boom")

    node = FlowNode(name="boomer", program_kind=ProgramKind.CALLBACK.value,
                    program_ref="flowtest_boom_cb")
    await node.save()
    await node.listen(await Topic.get_or_mint("flowtest.boom"))

    fm = FlowManager()
    await fm.emit(TopicEvent(topic="flowtest.boom.x"))
    topics = [e["topic"] for e in fm.journal_tail(limit=50)]
    assert "flow.error.flowtest.boom.x" in topics
