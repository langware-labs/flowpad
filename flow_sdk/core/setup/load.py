"""One provider lifecycle for Add, Open, CLI and setup approval.

Load checks setup without executing it. Only explicit approval runs prepare/run;
normal Load executes on_load after prerequisites hold. A provider's callers share
its existing project setup run, irrespective of which consumer opened its home.
"""
from __future__ import annotations

import asyncio
import dataclasses
import logging
from typing import Any, Optional

from flow_sdk.core.setup.tree import SetupNode
from flow_sdk.schema.data_spec.asset_setup_spec import LoadResult, LoadState, SetupState
from flow_sdk.stream_inbox._locks import keyed_loop_lock, new_registry

logger = logging.getLogger(__name__)
_LOCKS = new_registry()
_RESULTS: dict[str, LoadResult] = {}


class LoadTree:
    """The same dependency graph, with only operational wizards enabled.

    Keeping children is essential: project and app declarations live on child
    nodes. Setup's prepare/run never leak into this phase.
    """

    def __init__(self, tree):
        self.tree = tree
        self.root = tree.root
        self.resolve_op = tree.resolve_op

    async def resolve_node(self, node_id: str) -> Optional[SetupNode]:
        node = await self.tree.resolve_node(node_id)
        if node is None:
            return None
        children = node.children
        if node_id == self.root:
            # Project declarations establish the service before its apps start.
            children = tuple(c for c in children if c.startswith("asset_setup:")) + tuple(
                c for c in children if not c.startswith("asset_setup:"))
        return dataclasses.replace(node, prepare=None, run=node.on_load, children=children, record=None)


def load_state(project_id: str, *, asset: str = "") -> Optional[LoadResult]:
    """Observe the shared run, without starting any work or approving setup."""
    from flow_sdk.builtin.project_setup import _RUNS, setup_run_address

    pid = str(project_id)
    task = _RUNS.get((pid, ""))
    result = _RESULTS.get(pid)
    display = result.display if result is not None else None
    if task is not None:
        if not task.done():
            result = LoadResult(state=LoadState.RUNNING, project_id=pid, run=setup_run_address(pid), display=display)
        elif result is not None and result.state is LoadState.RUNNING:
            try:
                answer = task.result()
                if answer is None:
                    raise RuntimeError("The setup run returned no result")
                result = LoadResult(
                    state=LoadState.READY if answer.ok else LoadState.FAILED,
                    project_id=pid, detail=answer.detail, run=setup_run_address(pid), display=display,
                )
            except (Exception, asyncio.CancelledError) as exc:
                result = LoadResult(state=LoadState.FAILED, project_id=pid, detail=str(exc) or "Setup was cancelled", display=display)
            _RESULTS[pid] = result
    return result.model_copy(update={"asset": asset or None}) if result is not None else None


def _configuration_failure(node) -> str:
    """Unmet checks are pending; invalid declarations are failures even in check mode."""
    if node is None:
        return ""
    if node.state in (SetupState.FAILED, SetupState.REFUSED):
        return node.detail
    return next((detail for child in node.children if (detail := _configuration_failure(child))), "")


async def load_project(project: Any, *, approved: bool = False, asset: Any = None, tree: Any = None,
                       ancestors: tuple[str, ...] = (), display: str = "") -> LoadResult:
    """Check or start a provider's lifecycle; approval is explicit and never inferred from Add/Open."""
    from flow_sdk.builtin.project_dependencies import required_projects
    from flow_sdk.builtin.project_setup import start_setup
    from flow_sdk.core.setup.derive import ProjectTree
    from flow_sdk.core.setup.execute import execute_setup

    pid = str(project.id)
    target = str(asset.typeid) if asset is not None else ""
    if pid in ancestors:
        return LoadResult(state=LoadState.FAILED, project_id=pid,
                          detail=f"The provider lifecycle has a dependency cycle: {' -> '.join((*ancestors, pid))}")
    # Traverse before taking this provider's lock: opposite ends of a dependency
    # cycle may be loaded concurrently, and must never wait on each other's lock.
    try:
        providers = await required_projects(project) if hasattr(project, "dependencies") else []
        children = [await load_project(p, ancestors=(*ancestors, pid)) for p in providers]
    except Exception as exc:
        result = LoadResult(state=LoadState.FAILED, project_id=pid, detail=str(exc))
        _RESULTS[pid] = result
        return result
    async with keyed_loop_lock(_LOCKS, pid):
        current = load_state(pid, asset=target)
        if current is not None and current.state is LoadState.RUNNING:
            return current
        try:
            failed = next((c for c in children if c.state is LoadState.FAILED), None)
            if failed:
                raise ValueError(f"Dependency {failed.project_id}: {failed.detail}")
            tree = tree or await ProjectTree(project, display=display).load()
            if getattr(tree, "gaps", None):
                raise ValueError("; ".join(gap.note or gap.name for gap in tree.gaps))
            common = dict(subject_entity=f"project-{pid}", cwd=getattr(project, "fs_storage_mount_path", None),
                          check_only=True, approved=True)
            prerequisites = await execute_setup(tree.root, resolve_node=tree.resolve_node,
                                                resolve_op=tree.resolve_op, **common)
            problem = _configuration_failure(prerequisites.root)
            if problem:
                raise ValueError(problem)
            missing = next((c for c in children if c.state is LoadState.SETUP_REQUIRED), None)
            needs_setup = not prerequisites.ok or missing is not None
            if needs_setup and not approved:
                state = LoadState.FAILED if prerequisites.state is SetupState.REFUSED else LoadState.SETUP_REQUIRED
                result = LoadResult(state=state, project_id=pid, detail=missing.detail if missing else prerequisites.detail)
            else:
                operational = LoadTree(tree)
                running = await execute_setup(tree.root, resolve_node=operational.resolve_node,
                                               resolve_op=operational.resolve_op, **common) if not needs_setup else None
                if running is not None and running.ok and all(c.state is LoadState.READY for c in children):
                    result = LoadResult(state=LoadState.READY, project_id=pid)
                else:
                    run = await start_setup(project, tree=tree if needs_setup else operational,
                                            load_after=needs_setup, providers=providers,
                                            dependency_approval=approved, ancestors=(*ancestors, pid))
                    result = LoadResult(state=LoadState.RUNNING, project_id=pid, run=run)
        except Exception as exc:
            logger.warning("load of project %s failed: %s", pid, exc, exc_info=True)
            result = LoadResult(state=LoadState.FAILED, project_id=pid, detail=str(exc))
        result = result.model_copy(update={"display": display or None})
        _RESULTS[pid] = result
        return result.model_copy(update={"asset": target or None})


async def load_asset(project: Any, asset: Any) -> LoadResult:
    """Display uses the same prerequisite gate as dependency Add and project Open."""
    if project is None:
        return LoadResult(state=LoadState.FAILED, project_id="", asset=str(asset.typeid),
                          detail="This asset has no local provider project")
    return await load_project(project, asset=asset)


__all__ = ["LoadTree", "load_asset", "load_project", "load_state"]
