"""Walk a setup tree: each node's ``prepare`` on the way down, its children, its ``run`` on the way up.

The walk is a sequencer over the wizard runner, the way a wizard is a sequencer over ops: every check,
command, question and agent still lives in a ComputeOp, and every node's wizard runs through
``run_wizard`` unchanged. What only a TREE owns is here:

* **Order.** ``prepare`` before the children (it may ask early, or prove the node can run at all), the
  children depth first and one at a time, ``run`` after them. Its ``prepare`` outputs are in scope for
  every node below it.
* **A failure blocks upward, never sideways.** A child that failed leaves its parent ``blocked`` (its
  ``run`` is not attempted); the parent's other children still run, so every leaf reports its own truth.
* **One visit per node.** A credential two sources share is set up once; its second parent reads the
  verdict (``shared``). A cycle is refused before anything runs, and so is a tree past
  ``MAX_SETUP_DEPTH``.
* **A refusal stops everything**, as it stops a wizard: continuing past an untrusted callee is what the
  trust gate exists to prevent.
* **Check only** runs every node's wizards in check mode — nothing asks, installs or spawns — so "is this
  project ready" and "set this project up" are the same walk.
* **A load is a one-node tree.** ``core/setup/load`` wraps the resolver so the asset's node arrives with
  no prepare, no children and its ``on_load`` as ``run``; the walk, the slot and the record are the same.

**One report.** The Activity tree is ``<root>`` → one node per asset (its depth under the root in the
``level`` counter, so a screen indents it) → ``prepare`` / ``run`` → the wizard's steps. The asset
hierarchy is NOT nested on the wire: the Activity tree is capped at three tiers (``MAX_DEPTH``, a wire
budget), and a project's tree is deeper than that. The full hierarchy is the ``SetupTreeResult`` handed
to ``on_change`` after every step — the same document the run records.
"""

from __future__ import annotations

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
    specs: dict[str, Optional[SetupNode]] = field(default_factory=dict)
    first: dict[str, _Node] = field(default_factory=dict)
    visited: dict[str, SetupState] = field(default_factory=dict)
    root: Optional[_Node] = None
    activity: Any = None
    ran: bool = False

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
            return _Node(id=node_id, label=original.label, level=level, shared=True)
        spec = await self.resolve_node(node_id)
        self.specs[node_id] = spec
        node = _Node(id=node_id, label=(spec.label if spec else "") or node_id, level=level)
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
        state = await self._visit(node, scope)
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
        if spec.skipped:
            return self.settle(node, act, SetupState.SKIPPED, spec.skipped)
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
        stuck = [child for child in node.children if await self.visit(child, scope) not in settled]
        if stuck:
            names = ", ".join(child.label for child in stuck)
            return self.settle(node, act, SetupState.BLOCKED, f"waiting on {names}")

        if spec.run is not None:
            node.run = await self.wizard(spec, spec.run, act, node, "run", scope)
            await self._record(spec, node.run)
            if not node.run.ok:
                return self.settle(node, act, self._unmet(), node.run.detail or "did not finish")
        return self.settle(node, act, SetupState.DONE, _done_detail(node))

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

        result = await run_wizard(
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
        )
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
        return walk.answer(SetupState.REFUSED, str(refused))
    root = walk.root
    detail = "" if state is SetupState.DONE else f"{root.label}: {root.detail}"
    return walk.answer(state, detail)
