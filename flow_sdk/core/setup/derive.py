"""A project's setup tree, derived: what every asset in it needs, as nodes the walk sets up leaf first.

Nothing here is new knowledge. Each node wraps a derivation that already exists, so the tree and the
places that answered these questions one at a time cannot disagree:

| node id | children | run |
|---|---|---|
| ``project-<id>`` (root) | its dependencies, connections and credentials nobody below uses, its sources, its web apps, what is declared for it | — |
| ``dependency:<name>`` | — | ``flow dep sync`` ✓ ``flow dep check`` (``project_setup.compile_setup``) |
| ``connection:<provider>`` | — | ``flow connections connect`` ✓ ``connections test`` (same) |
| ``credential:<name>`` | — | ask each missing value → ``credentials set`` ✓ ``credentials check`` (same) |
| ``data_source-<id>`` | the connections and credentials it needs, then its last setup stage | — |
| ``stage:<source>:<wizard>`` | the stage before it (a stage is never set up before the one it follows) | the driver's stage wizard, FOR the source — recorded where the stage list reads it |
| ``micro_app-<id>`` | — | install → build → start (``webapp_setup``), each with its own check; its ``on_load`` is the same chain |
| ``asset_setup:<name>`` | its declared children | its declared ``prepare`` / ``run`` wizards (and ``on_load``, run on display — ``core/setup/load``) |

A declared ``asset_setup`` attaches to the node it is for: its ``subject`` (a node id, or
``data_driver:<name>`` for every source of that driver), else the asset whose folder holds it — so a
connector ships the setup of what it needs (WAHA's container) inside its own folder.
"""

from __future__ import annotations

import asyncio
import dataclasses
import logging
from pathlib import Path
from typing import Any, Optional

from flow_sdk.core.setup.tree import SetupNode
from flow_sdk.core.wizard.runner import Resolved
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.returned_value_spec import WizardResult
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec

logger = logging.getLogger(__name__)

PROJECT = "project"


def _op(name: str, label: str, step: str, *, kind: str = "webapp_step") -> ComputeOpSpec:
    """An in-process step of the run's web app (``webapp_step``) or source (``source_step``): the call is the
    step, the check is the same step in check mode."""
    return ComputeOpSpec.model_validate({
        "name": name, "label": label, "subkind": "cli", "exe_data": {kind: step}, "completion_check": {kind: step},
    })


def _holder(asset_ref: str) -> str:
    """The node a declared ``asset_setup`` folder is for when it does not say: the asset folder that holds
    it (``data_driver:<name>`` inside a driver, ``data_source:<name>`` inside a source), else the project."""
    parts = Path(asset_ref).parts
    for family in ("data_source", "data_driver"):
        for i in range(len(parts) - 2, -1, -1):
            if parts[i] == family and i + 1 < len(parts) and parts[i + 1] != "asset_setup":
                return f"{family}:{parts[i + 1]}"
    return PROJECT


class ProjectTree:
    """One project's derived setup tree. ``load()`` once, then hand ``resolve_node`` / ``resolve_op`` to
    ``execute_setup``. Built in memory per run, like the setup wizard it replaces — nothing is written."""

    def __init__(self, project: Any, *, ai: bool = True):
        self.project = project
        self.pid = str(project.id)
        self.root = f"project-{self.pid}"
        self.ai = ai
        self.nodes: dict[str, SetupNode] = {}
        self.ops: dict[str, ComputeOpSpec] = {}
        self.gaps: list = []
        #: A source's FIRST setup stage: what the source needs is set up before it, never beside it.
        self.first_stage: dict[str, str] = {}
        self._drivers: dict[str, Any] = {}
        self._wizards: dict[str, Any] = {}

    async def _driver(self, provider: str) -> Any:
        """A driver once per tree, however many sources run it."""
        from flow_sdk.builtin.readiness import driver_of  # noqa: PLC0415

        if provider not in self._drivers:
            self._drivers[provider] = await driver_of(provider)
        return self._drivers[provider]

    async def _wizard(self, name: str) -> Any:
        """A Wizard row once per tree, however many sources' stages name it."""
        from flow_sdk.builtin.wizard import Wizard  # noqa: PLC0415

        if name not in self._wizards:
            self._wizards[name] = await Wizard.by_name(name)
        return self._wizards[name]

    # ── what the walk asks ─────────────────────────────────────────────────

    async def resolve_node(self, node_id: str) -> Optional[SetupNode]:
        return self.nodes.get(node_id)

    async def resolve_op(self, name: str) -> Optional[Resolved]:
        if name in self.ops:
            return Resolved(self.ops[name], True)
        from flow_sdk.core.wizard.execute import _resolve_op  # noqa: PLC0415

        return await _resolve_op(name)

    # ── building ───────────────────────────────────────────────────────────

    async def load(self) -> "ProjectTree":
        from flow_sdk.builtin.project_setup import collect_requirements, project_sources  # noqa: PLC0415
        from flow_sdk.schema.data_spec.project_setup_spec import REQUIREMENT_GAP  # noqa: PLC0415

        requirements = await collect_requirements(self.project)
        self.gaps = [r for r in requirements if r.kind == REQUIREMENT_GAP]
        sources = await project_sources(self.project)
        source_names = {str(s.name or s.provider): s for s in sources}

        under: dict[str, list[str]] = {self.root: []}
        for req in requirements:
            if req.kind == REQUIREMENT_GAP:
                continue  # nobody's to run: reported beside the tree, never a node that blocks it
            if not req.required and req.skipped is None:
                continue  # optional: set up from its own page when wanted, never a node a project waits on
            node_id = self._requirement_node(req)
            users = [who for who in req.used_by if who in source_names]
            for who in users:
                under.setdefault(str(source_names[who].typeid), []).append(node_id)
            if not users or set(req.used_by) - set(source_names):
                under[self.root].append(node_id)

        for source in sources:
            under[self.root].append(await self._source_node(source, under.get(str(source.typeid), [])))
        for app in await self._webapps():
            under[self.root].append(self._webapp_node(app))
        await self._declared(sources, under)

        self.nodes[self.root] = SetupNode(
            id=self.root, label=str(getattr(self.project, "name", "") or "Project"),
            children=tuple(dict.fromkeys(under[self.root])), inputs=(("project", self.pid),),
        )
        return self

    def _skipped(self, node_id: str, label: str, mark) -> bool:
        """A node skipped here (``mark`` set) settles SKIPPED: nothing of it compiles or runs."""
        if mark is None:
            return False
        note = str(getattr(mark, "note", "") or "").strip()
        detail = f"skipped on this machine — {note}" if note else "skipped on this machine"
        self.nodes[node_id] = SetupNode(id=node_id, label=label, skipped=detail)
        return True

    def _requirement_node(self, req) -> str:
        from flow_sdk.builtin.project_setup import compile_setup  # noqa: PLC0415

        node_id = requirement_node_id(req)
        if node_id not in self.nodes:
            label = req.title or req.name
            if self._skipped(node_id, label, req.skipped):
                return node_id
            wizard, ops = compile_setup(self.pid, [req], ai=self.ai)
            self.ops.update(ops)
            self.nodes[node_id] = SetupNode(
                id=node_id, label=label,
                run=wizard.model_copy(update={"name": node_id, "label": label}) if wizard.steps else None,
            )
        return node_id

    async def _source_node(self, source, needs: list[str]) -> str:
        node_id = str(source.typeid)
        if self._skipped(node_id, str(source.name or source.provider), source.setup_skipped):
            return node_id
        inputs = (("source", str(source.id)), ("owner", str(source.owner or "")))
        driver = await self._driver(source.provider or "")
        needs = list(dict.fromkeys(needs))
        before = ""
        for stage in getattr(driver, "setup_wizards", None) or []:
            wizard = await self._wizard(stage.wizard)
            spec = wizard.spec() if wizard is not None else None
            if spec is None:
                logger.warning("setup: %s names the wizard %r, which is not indexed", source.provider, stage.wizard)
            stage_id = f"stage:{source.id}:{stage.wizard}"
            # The first stage needs what the source needs (its credentials, connections, a container); each
            # later one needs the stage before it.
            self.nodes[stage_id] = SetupNode(
                id=stage_id, label=stage.display_label, run=spec, trusted=bool(wizard and wizard.is_system()),
                children=(before,) if before else tuple(needs), inputs=inputs,
                record=_stage_recorder(wizard, node_id) if spec is not None else None,
            )
            if not before:
                self.first_stage[node_id] = stage_id
            before = stage_id
        # A source whose driver declares no stages still has to verify: the same check as its Verify
        # button (the source turns active when it passes) — else the tree calls "done" a source in setup.
        verify = None
        if not before:
            op = _op(f"{node_id}:verify", "Verify", "verify", kind="source_step")
            self.ops[op.name] = op
            verify = WizardSpec.model_validate({
                "name": op.name, "label": "Verify",
                "steps": [{"id": "verify", "label": "Verify", "kind": "compute", "ref": op.name}],
            })
        self.nodes[node_id] = SetupNode(
            id=node_id, label=str(source.name or source.provider), children=tuple([before] if before else needs),
            inputs=inputs, run=verify,
        )
        return node_id

    async def _webapps(self) -> list:
        from flow_sdk.builtin.faas.micro_app import WebApp  # noqa: PLC0415

        apps = await WebApp.get_all({"match": {"project_id": self.pid}})
        return [app for app in apps if app.asset_ref]

    def _webapp_node(self, app) -> str:
        node_id = str(app.typeid)
        label = str(app.title or app.name) if hasattr(app, "title") else str(app.name)
        if self._skipped(node_id, label, app.setup_skipped):
            return node_id
        steps = []
        for step, what in (("install", "Install"), ("build", "Build"), ("start", "Start")):
            op = _op(f"{node_id}:{step}", f"{what} {label}", step)
            self.ops[op.name] = op
            steps.append({"id": step, "label": what, "kind": "compute", "ref": op.name})
        chain = WizardSpec.model_validate({"name": node_id, "label": f"Run {label}", "steps": steps})
        # Loading the app is making sure it is up: the same chain, whose checks are what "up" means
        # (installed, built, a server answering its health path). Done already, it costs three checks.
        self.nodes[node_id] = SetupNode(id=node_id, label=label, inputs=(("webapp", str(app.id)),), run=chain, on_load=chain)
        return node_id

    async def load_one(self, asset: Any) -> "ProjectTree":
        """Only ``asset``'s own node — what a LOAD needs (``core/setup/load``). A web app's node derives from
        its row alone, so no requirement, source or declared setup is read; any other asset needs the tree."""
        if getattr(asset, "get_type", lambda: "")() == "micro_app" and getattr(asset, "asset_ref", ""):
            self._webapp_node(asset)
            return self
        return await self.load()

    async def _declared(self, sources: list, under: dict[str, list[str]]) -> None:
        """Every ``asset_setup`` the project's folder or its sources' drivers hold, attached where it is for."""
        from flow_sdk.builtin.asset_setup import AssetSetup  # noqa: PLC0415
        from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415

        roots = [str(getattr(self.project, "fs_storage_mount_path", "") or "")]
        for source in sources:
            driver = await self._driver(source.provider or "")
            folder = str(getattr(driver, "folder", "") or getattr(driver, "asset_ref", "") or "")
            if folder:
                roots.append(folder)
        roots = [r.rstrip("/") for r in roots if r]
        if not roots:
            return
        # Only what lives under the project's folder or its sources' driver folders — asked of the index,
        # never every setup on the machine filtered here.
        likes = [ExpressionNode(op=QueryOp.LIKE, operands=["asset_ref", f"{root}/%"]) for root in roots]
        match = likes[0] if len(likes) == 1 else ExpressionNode(op=QueryOp.OR, operands=likes)
        rows = [row for row in await AssetSetup.get_all(QueryFilter(match=match)) if row.asset_ref]
        by_name = {str(row.name): row for row in rows}

        async def wizard(name: str) -> Optional[WizardSpec]:
            row = await self._wizard(name) if name else None
            return row.spec() if row is not None else None

        for row in rows:
            spec = row.spec()
            node_id = f"asset_setup:{(spec.name if spec else '') or row.name}"
            if spec is None:
                self.nodes[node_id] = SetupNode(id=node_id, label=str(row.name), problem=(
                    f"{row.asset_ref}/asset_setup.json cannot be read"))
                continue
            prepare, run, load = await asyncio.gather(wizard(spec.prepare), wizard(spec.run), wizard(spec.on_load))
            missing = [n for n, w in ((spec.prepare, prepare), (spec.run, run), (spec.on_load, load)) if n and w is None]
            children = tuple(f"asset_setup:{c}" if c in by_name else c for c in spec.children)
            self.nodes[node_id] = SetupNode(
                id=node_id, label=spec.label or spec.name or row.name, prepare=prepare,
                run=run, on_load=load, children=children, trusted=row.is_system(),
                inputs=tuple((str(k), str(v)) for k, v in (spec.inputs or {}).items()),
                problem=f"{spec.name} names the wizard {', '.join(map(repr, missing))}, which is not here" if missing else "",
            )
            for parent in self._attach_to(spec.subject or _holder(row.asset_ref), sources):
                # A source with stages needs it before its first stage; the stage is where it attaches.
                parent = self.first_stage.get(parent, parent)
                under.setdefault(parent, []).append(node_id)
                if parent in self.nodes and parent != self.root:
                    old = self.nodes[parent]
                    self.nodes[parent] = dataclasses.replace(old, children=(node_id, *old.children))

    def _attach_to(self, subject: str, sources: list) -> list[str]:
        if subject in (PROJECT, "", self.root):
            return [self.root]
        if subject.startswith("data_driver:"):
            driver = subject.split(":", 1)[1]
            return [str(s.typeid) for s in sources if s.provider == driver]
        if subject.startswith("data_source:"):
            name = subject.split(":", 1)[1]
            return [str(s.typeid) for s in sources if str(s.name) == name or Path(str(s.asset_ref or "")).name == name]
        return [subject]


def requirement_node_id(req) -> str:
    """The tree node a collected requirement is (``dependency:`` / ``connection:`` / ``credential:<name>``)."""
    from flow_sdk.schema.data_spec.project_setup_spec import REQUIREMENT_DEPENDENCY  # noqa: PLC0415

    if req.is_oauth:
        return f"connection:{req.provider or req.name}"
    prefix = {REQUIREMENT_DEPENDENCY: "dependency"}.get(req.kind, "credential")
    return f"{prefix}:{req.name}"


def _stage_recorder(wizard, target: str):
    """A stage's run, written where ``stage_states`` reads it — so the stage list and the tree agree."""

    async def record(result: WizardResult) -> None:
        from flow_sdk.core.wizard.state import record_result, run_key  # noqa: PLC0415

        record_result(run_key(str(wizard.id), target), result)

    return record
