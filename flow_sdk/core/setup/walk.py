"""Walk a setup tree: each node's ``prepare`` on the way down, its children, its ``run`` on the way up.

The walk is a sequencer over the wizard runner, the way a wizard is a sequencer over ops: every check,
command, question and agent still lives in a ComputeOp, and every node's wizard runs through
``run_wizard`` unchanged. What only a TREE owns is here:

* **Order.** ``prepare`` before the children (it may ask early, or prove the node can run at all), the
  children depth first and one at a time, ``run`` after them. Its ``prepare`` outputs are in scope for
  every node below it.
* **Nothing blocks; every node does its best.** A child that failed never stops anything: its siblings
  run, and its parent's ``run`` is still attempted. The parent then settles ``blocked`` naming what is
  not set up under it — the run is not done, but everything that could be done was.
* **One visit per node.** A credential two sources share is set up once; its second parent reads the
  verdict (``shared``). A cycle is refused before anything runs, and so is a tree past
  ``MAX_SETUP_DEPTH``.
* **A refusal stops everything**, as it stops a wizard: continuing past an untrusted callee is what the
  trust gate exists to prevent.
* **Check only** runs every node's wizards in check mode — nothing asks, installs or spawns — so "is this
  project ready" and "set this project up" are the same walk.
* **Load keeps the dependency graph.** ``core/setup/load`` wraps its resolver with no prepare and each
  node's ``on_load`` as ``run``; the walk, slot and record are shared with setup.

**One report.** The Activity tree is ``<root>`` → one node per asset (its depth under the root in the
``level`` counter, so a screen indents it) → ``prepare`` / ``run`` → the wizard's steps. The asset
hierarchy is NOT nested on the wire: the Activity tree is capped at three tiers (``MAX_DEPTH``, a wire
budget), and a project's tree is deeper than that. The full hierarchy is the ``SetupTreeResult`` handed
to ``on_change`` after every step — the same document the run records.
"""

from __future__ import annotations

import asyncio
import logging
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

from flow_sdk.core.compute.process_step import launch_step_process
from flow_sdk.core.compute.shared_shell import shell_for
from flow_sdk.core.compute_op.runner import Launch, Shell
from flow_sdk.core.setup.tree import NodeResolver, SetupNode
from flow_sdk.core.wizard.runner import OpResolver, WizardResolver, run_wizard
from flow_sdk.schema.data_spec.asset_setup_spec import SetupNodeResult, SetupState, SetupTreeResult
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode, WizardResult
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec

logger = logging.getLogger(__name__)

#: How deep a setup tree may go. A project → its source → the source's credential is three; past eight
#: something is generating children, not describing assets.
MAX_SETUP_DEPTH = 8

OnChange = Callable[[SetupTreeResult], Awaitable[None]]


class _Stop(Exception):
    """A refusal: the walk ends here, whatever is left."""


class SetupControl:
    """A live run's handle: skip a node, or stop the run, while the walk goes.

    * **Skip.** A node not reached yet settles SKIPPED when the walk gets there; the node running now (or
      one under it) has its wizard cancelled — its shell's process groups killed, its open question
      withdrawn, the way a replaced wizard start is — and settles SKIPPED, so the walk goes on.
    * **Stop.** The running wizard is cancelled the same way; its node and the run settle STOPPED.

    What the person asked for is recorded here, so the walk reads it rather than guessing from the cancel.
    """

    def __init__(self) -> None:
        self.skips: dict[str, str] = {}
        self.stopped = False
        self._path: tuple[str, ...] = ()
        self._task: Optional[asyncio.Task] = None

    def skip(self, node_id: str, detail: str = "skipped") -> None:
        self.skips[node_id] = detail
        if self._task is not None and node_id in self._path:
            self._task.cancel()

    def stop(self) -> bool:
        """Stop the walk at the wizard it is running. ``False`` when it is not in one (nothing to cancel)."""
        if self._task is None:
            return False
        self.stopped = True
        self._task.cancel()
        return True

    def skipped(self, path: tuple[str, ...]) -> str:
        """The skip that covers a node on ``path`` (it or a node above it), else ``""``."""
        return next((self.skips[i] for i in reversed(path) if i in self.skips), "")

    async def run(self, path: tuple[str, ...], task: "asyncio.Task") -> Any:
        """Await the wizard ``task`` of the node at ``path`` as the one a skip or a stop reaches.

        Raises ``_Stopped`` / ``_Skipped`` when a person ended it; a cancel of the run itself (the caller's)
        takes the wizard down with it and propagates."""
        self._path, self._task = path, task
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            if not task.cancelled():  # the run itself was cancelled, not this wizard
                task.cancel()
                await asyncio.wait({task})  # its shells and question gone before the run lets go
                raise
            raise (_Stopped() if self.stopped else _Skipped()) from None
        finally:
            self._path, self._task = (), None


class _Skipped(Exception):
    """The running node's wizard was cancelled by :meth:`SetupControl.skip`."""


class _Stopped(Exception):
    """The running node's wizard was cancelled by :meth:`SetupControl.stop`: the walk ends here."""


@dataclass
class _Node:
    """One node of the run's own tree: mutable while the walk goes, rendered as a ``SetupNodeResult``."""

    id: str
    label: str
    level: int
    state: SetupState = SetupState.PENDING
    detail: str = ""
    prepare: Optional[WizardResult] = None
    run: Optional[WizardResult] = None
    children: list["_Node"] = field(default_factory=list)
    #: Not the first place this id appears: it stands for the node set up where it first appeared.
    shared: bool = False
    #: ``SetupNode.independent``: its parent settles without it.
    independent: bool = False

    def render(self) -> SetupNodeResult:
        return SetupNodeResult(
            id=self.id,
            label=self.label,
            level=self.level,
            state=self.state,
            detail=self.detail,
            prepare=self.prepare,
            run=self.run,
            children=[child.render() for child in self.children],
            shared=self.shared,
            independent=self.independent,
        )


class _Quiet:
    """An Activity node that reports nowhere — a check is a question, not a job anyone should watch."""

    def __getattr__(self, _name: str) -> Callable[..., "_Quiet"]:
        return lambda *_a, **_k: self


def _segment(node_id: str) -> str:
    """A node id as ONE Activity path segment (``/`` would nest it)."""
    return node_id.replace("/", "_") or "node"


@dataclass
class _Walk:
    resolve_node: NodeResolver
    resolve_op: Optional[OpResolver]
    resolve_wizard: Optional[WizardResolver]
    shell: Shell
    launch: Launch
    workdir: Path
    platform: str
    subject_entity: Optional[str]
    check_only: bool
    approved: bool
    wizard_id: str
    on_change: Optional[OnChange]
    control: SetupControl = field(default_factory=SetupControl)
    path: tuple[str, ...] = ()
    specs: dict[str, Optional[SetupNode]] = field(default_factory=dict)
    first: dict[str, _Node] = field(default_factory=dict)
    visited: dict[str, SetupState] = field(default_factory=dict)
    root: Optional[_Node] = None
    activity: Any = None
    ran: bool = False
    _pending: Optional[asyncio.Future] = None

    # ── build: the whole outline before anything runs ─────────────────────

    async def build(self, root_id: str) -> None:
        """Resolve every node, depth first in walk order. Raises ``_Stop`` on a cycle or a runaway depth,
        so an author's mistake is named before any command runs."""
        self.root = await self._build(root_id, ())

    async def _build(self, node_id: str, above: tuple[str, ...]) -> _Node:
        if node_id in above:
            raise _Stop(f"the setup tree has a cycle: {' -> '.join((*above, node_id))}")
        if len(above) >= MAX_SETUP_DEPTH:
            raise _Stop(f"the setup tree is more than {MAX_SETUP_DEPTH} levels deep: {' -> '.join((*above, node_id))}")
        level = len(above)
        if node_id in self.first:
            original = self.first[node_id]
            return _Node(id=node_id, label=original.label, level=level, shared=True, independent=original.independent)
        spec = await self.resolve_node(node_id)
        self.specs[node_id] = spec
        node = _Node(id=node_id, label=(spec.label if spec else "") or node_id, level=level,
                     independent=spec is not None and spec.independent)
        self.first[node_id] = node
        if spec is None:
            node.state, node.detail = SetupState.FAILED, f"there is nothing named {node_id!r} to set up"
            return node
        for child in spec.children:
            node.children.append(await self._build(child, (*above, node_id)))
        return node

    # ── report ─────────────────────────────────────────────────────────────

    def outline(self) -> list[_Node]:
        """Every node once, in walk order — the plan the Activity root announces."""
        out: list[_Node] = []

        def walk(node: _Node) -> None:
            if node.shared:
                return
            out.append(node)
            for child in node.children:
                walk(child)

        if self.root is not None:
            walk(self.root)
        return out

    def answer(self, state: SetupState, detail: str) -> SetupTreeResult:
        nodes = self.outline()
        return SetupTreeResult(
            state=state,
            detail=detail,
            root=self.root.render() if self.root is not None else None,
            total=len(nodes),
            done=sum(1 for node in nodes if node.state in (SetupState.DONE, SetupState.SKIPPED)),
            ran=self.ran,
        )

    async def emit(self) -> None:
        if self.on_change is None:
            return
        try:
            await self.on_change(self.answer(SetupState.RUNNING, "still running"))
        except Exception:  # noqa: BLE001 — a broken watcher must not break the setup it watches
            logger.exception("setup on_change callback failed")

    def emit_soon(self) -> None:
        """Emit from a sync callback. One emit in flight at a time: it renders the tree when it
        runs, so a line that arrives meanwhile rides it instead of queueing another."""
        if self.on_change is None or (self._pending is not None and not self._pending.done()):
            return
        self._pending = asyncio.ensure_future(self.emit())

    async def settled(self) -> None:
        """Let a live-line emit land BEFORE the final answer, never after it: a late "still running"
        would overwrite the finished record."""
        if self._pending is not None:
            await self._pending

    def node_activity(self, node: _Node) -> Any:
        if self.activity is None:
            return _Quiet()
        return self.activity.child_or_self(_segment(node.id))

    # ── walk ───────────────────────────────────────────────────────────────

    async def visit(self, node: _Node, scope: dict) -> SetupState:
        if node.shared:
            original = self.first[node.id]
            state = self.visited.get(node.id) or await self.visit(original, scope)
            node.state, node.detail = state, f"set up with {original.label}" if state is SetupState.DONE else original.detail
            return state
        if node.id in self.visited:
            return self.visited[node.id]
        above, self.path = self.path, (*self.path, node.id)
        try:
            state = await self._visit(node, scope)
        except _Skipped:
            state = self.settle(node, self.node_activity(node), SetupState.SKIPPED, self.control.skipped(self.path))
        except _Stopped:  # this node and every one above it: where the run was when it stopped
            node.state, node.detail = SetupState.STOPPED, "stopped"
            self.node_activity(node).cancel("Stopped")
            raise
        finally:
            self.path = above
        self.visited[node.id] = state
        await self.emit()
        return state

    async def _visit(self, node: _Node, scope: dict) -> SetupState:
        act = self.node_activity(node)
        spec = self.specs.get(node.id)
        if spec is None:  # nothing by that id: failed at build
            act.fail(node.detail)
            self._count(node)
            return node.state
        if spec.problem:
            return self.settle(node, act, SetupState.FAILED, spec.problem)
        if skipped := spec.skipped or self.control.skipped(self.path):
            return self.settle(node, act, SetupState.SKIPPED, skipped)
        node.state = SetupState.RUNNING
        act.current("starting")
        await self.emit()
        scope = {**scope, **dict(spec.inputs)}

        if spec.prepare is not None:
            node.prepare = await self.wizard(spec, spec.prepare, act, node, "prepare", scope)
            if not node.prepare.ok:
                return self.settle(node, act, self._unmet(), node.prepare.detail or "prepare did not finish")
            if isinstance(node.prepare.value, dict):
                scope = {**scope, **node.prepare.value}

        settled = (SetupState.DONE, SetupState.SKIPPED)  # a skipped child holds nothing up
        left = [child for child in node.children if await self.visit(child, scope) not in settled]
        stuck = [child for child in left if not child.independent]
        if self.control.skipped(self.path):  # skipped while its children ran
            raise _Skipped()

        # Best effort: the node's own run is attempted whatever its children came to. A node with a child
        # that is not set up still says so first — that is what it is waiting on.
        failed = ""
        if spec.run is not None:
            node.run = await self.wizard(spec, spec.run, act, node, "run", scope)
            await self._record(spec, node.run)
            if not node.run.ok:
                failed = node.run.detail or "did not finish"
        if stuck:
            names = ", ".join(child.label for child in stuck)
            return self.settle(node, act, SetupState.BLOCKED, f"waiting on {names}")
        if failed:
            return self.settle(node, act, self._unmet(), failed)
        # What stands on its own never held this node up; say which of them it settled without.
        apart = f"; not set up: {', '.join(child.label for child in left)}" if left else ""
        return self.settle(node, act, SetupState.DONE, _done_detail(node) + apart)

    async def _record(self, spec: SetupNode, result: WizardResult) -> None:
        if spec.record is None or self.check_only:
            return
        try:
            await spec.record(result)
        except Exception:  # noqa: BLE001 — a record that cannot be written must not fail the setup it records
            logger.exception("setup node %s: recording its run failed", spec.id)

    def _unmet(self) -> SetupState:
        """A wizard that did not reach its goal: failed when setting up, pending when only checking."""
        return SetupState.PENDING if self.check_only else SetupState.FAILED

    def settle(self, node: _Node, act: Any, state: SetupState, detail: str) -> SetupState:
        node.state, node.detail = state, detail
        if state in (SetupState.DONE, SetupState.SKIPPED):
            act.done(detail)
        elif state is SetupState.BLOCKED:
            act.cancel(f"Blocked — {detail}")
        else:
            act.fail(detail)
        self._count(node)
        return state

    def _count(self, node: _Node) -> None:
        if self.activity is None:
            return
        if node.state is SetupState.DONE:
            self.activity.inc_success()
        elif node.state is SetupState.SKIPPED:
            self.activity.inc("skipped")
        elif node.state is SetupState.BLOCKED:
            self.activity.inc("blocked")
        else:
            self.activity.inc_error(f"{node.label}: {node.detail}", ref=node.id)

    async def wizard(self, spec: SetupNode, wizard: WizardSpec, act: Any, node: _Node, slot: str, scope: dict) -> WizardResult:
        """One of the node's wizards, reporting into the node's ``slot`` child."""
        slot_act = act.child_or_self(slot).label(wizard.label or wizard.name or slot).total(len(wizard.steps))
        act.current(wizard.label or wizard.name or slot)

        async def on_step(partial: WizardResult) -> None:
            setattr(node, slot, partial)
            await self.emit()

        def on_status(text: str) -> None:
            # The running node's one-liner: what its command is doing right now.
            if node.state is SetupState.RUNNING and text != node.detail:
                node.detail = text
                self.emit_soon()

        task = asyncio.ensure_future(run_wizard(
            wizard,
            subject_entity=self.subject_entity,
            # A person who approved THIS setup approved every node in it — the node's own wizard included,
            # which ``run_wizard`` gates on ``trusted`` alone (``approved`` reaches only its callees).
            trusted=spec.trusted or self.approved,
            approved=self.approved,
            workdir=self.workdir,
            inputs=scope,
            shell=self.shell,
            launch=self.launch,
            resolve_op=self.resolve_op,
            resolve_wizard=self.resolve_wizard,
            platform=self.platform,
            parent=slot_act,
            wizard_id=self.wizard_id,
            check_only=self.check_only,
            on_step=on_step,
            on_status=on_status,
        ))
        try:
            result = await self.control.run(self.path, task)
        except (_Skipped, _Stopped) as ended:
            slot_act.cancel("Stopped" if isinstance(ended, _Stopped) else "Skipped")
            raise
        self.ran = self.ran or result.ran
        if result.ok:
            slot_act.done(result.detail or "done")
        else:
            slot_act.fail(result.detail or "did not finish")
        if result.exit_code is ExitCode.REFUSED:
            setattr(node, slot, result)
            node.state, node.detail = SetupState.REFUSED, result.detail
            act.fail(result.detail)
            raise _Stop(result.detail)
        return result


def _done_detail(node: _Node) -> str:
    ran = any(r is not None and r.ran for r in (node.prepare, node.run))
    return "set up" if ran else "already set up"


async def setup_tree(
    root_id: str,
    *,
    resolve_node: NodeResolver,
    resolve_op: Optional[OpResolver] = None,
    resolve_wizard: Optional[WizardResolver] = None,
    activity_path: str = "setup",
    subject_entity: Optional[str] = None,
    workdir: Optional[Path] = None,
    inputs: Optional[dict] = None,
    shell: Optional[Shell] = None,
    launch: Launch = launch_step_process,
    platform: str = "",
    check_only: bool = False,
    approved: bool = False,
    wizard_id: str = "",
    on_change: Optional[OnChange] = None,
    control: Optional[SetupControl] = None,
) -> SetupTreeResult:
    """Set up ``root_id`` and everything below it. Never raises for an outcome.

    ``check_only``: report, run nothing, take no Activity address (a readiness question must not hold the
    slot a real setup needs, and nobody should watch it). Otherwise the run claims ``activity_path`` —
    a second run of the same root answers ``held``.
    """
    from flow_sdk.activity import Activity  # noqa: PLC0415 — keeps this module entity-free at import

    work = Path(workdir) if workdir else Path.cwd()
    work.mkdir(parents=True, exist_ok=True)
    async with shell_for(False, shell) as shell:
        walk = _Walk(
            resolve_node=resolve_node,
            resolve_op=resolve_op,
            resolve_wizard=resolve_wizard,
            shell=shell,
            launch=launch,
            workdir=work,
            platform=platform or sys.platform,
            subject_entity=subject_entity,
            check_only=check_only,
            approved=approved,
            wizard_id=wizard_id,
            on_change=on_change,
            control=control or SetupControl(),
        )
        try:
            await walk.build(root_id)
        except _Stop as refused:
            return walk.answer(SetupState.REFUSED, str(refused))

        if check_only:
            return await _walk(walk, dict(inputs or {}))
        claimed = False
        try:
            async with Activity.claim(activity_path, subject_entity=subject_entity, queue=False) as root:
                claimed = True
                walk.activity = root
                outline = walk.outline()
                root.label(walk.root.label if walk.root else root_id).total(len(outline))
                root.plan([
                    {"name": _segment(node.id), "label": node.label, "counters": {"level": node.level}}
                    for node in outline
                ])
                result = await _walk(walk, dict(inputs or {}))
                if not result.ok:
                    root.fail(result.detail)  # sticky: wins over the claim's exit done()
                return result
        except RuntimeError as busy:
            if claimed:
                raise
            return SetupTreeResult(state=SetupState.HELD, detail=f"{root_id} is already being set up: {busy}")


async def _walk(walk: _Walk, inputs: dict) -> SetupTreeResult:
    assert walk.root is not None
    await walk.emit()
    try:
        state = await walk.visit(walk.root, inputs)
    except _Stop as refused:
        await walk.settled()
        return walk.answer(SetupState.REFUSED, str(refused))
    except _Stopped:
        await walk.settled()
        return walk.answer(SetupState.STOPPED, "Stopped")
    await walk.settled()
    root = walk.root
    detail = "" if state is SetupState.DONE else f"{root.label}: {root.detail}"
    return walk.answer(state, detail)
