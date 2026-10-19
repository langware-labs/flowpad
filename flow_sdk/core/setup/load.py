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
#: Each load's verdict, per ``(provider, asset)``: two apps of one project are two loads, and the run one
#: of them started (its question, its progress) is never the other's.
_RESULTS: dict[tuple[str, str], LoadResult] = {}
#: The asset each provider was last loaded for — what a poll that names none is about.
_LATEST: dict[str, str] = {}

#: ``(provider, asset)`` whose failed load already had its one setup run: a second failure is the
#: answer, not a loop.
_REPAIRED: set[tuple[str, str]] = set()


def _keep(pid: str, asset: str, result: LoadResult) -> LoadResult:
    _RESULTS[(pid, asset)] = result
    _LATEST[pid] = asset
    return result


class LoadTree:
    """The same dependency graph, with only operational wizards enabled.

    Keeping children is essential: project and app declarations live on child
    nodes. Setup's prepare/run never leak into this phase. ``fix``: an op's agent
    rung (the setup-fixer) and the rungs after it stay; a plain load never runs an
    agent, only the load a setup run ends with does.
    """

    def __init__(self, tree, *, fix: bool = False):
        self.tree = tree
        self.root = tree.root
        self.fix = fix

    async def resolve_op(self, name: str):
        resolved = await self.tree.resolve_op(name)
        rungs = list(getattr(resolved.spec, "attempts", None) or []) if resolved is not None else []
        agent = next((at for at, rung in enumerate(rungs) if rung.subkind == "agent"), None)
        if self.fix or agent is None:
            return resolved
        return dataclasses.replace(resolved, spec=resolved.spec.model_copy(update={"attempts": rungs[:agent]}))

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


def forget(project_id: str, asset: str = "") -> None:
    """Drop the provider's last verdicts: what they were checked against has changed (a setup run of the
    project ended, one of its sources changed status), and nothing refreshes a kept one. With none,
    ``load_state`` answers None and the next Load checks again. ``asset``: what the run was rooted at. An
    app stands beside its siblings, so a run of one app outdates that app and the project's own verdict —
    never another app's; a run of anything else (a service, a credential) may be what every app stands
    on. A RUNNING verdict stays: ``load_state`` settles it from its run."""
    pid = str(project_id)
    app_only = asset.startswith("micro_app-")
    for key in [k for k, v in _RESULTS.items()
                if k[0] == pid and (not app_only or k[1] in ("", asset)) and v.state is not LoadState.RUNNING]:
        del _RESULTS[key]


def load_state(project_id: str, *, asset: str = "") -> Optional[LoadResult]:
    """Observe the shared run, without starting any work or approving setup."""
    from flow_sdk.builtin.project_setup import _RUNS, setup_run_address

    pid = str(project_id)
    # The run was started FOR an app: it is judged on that app whoever asks — a poll that names none
    # must not settle it as ready because the project stands without it.
    asset = asset or _LATEST.get(pid, "")
    result = _RESULTS.get((pid, asset))
    display = result.display if result is not None else None
    # Opening an app runs that app alone (rooted at it); the project's own run is the other kind.
    root = asset if asset and (pid, asset) in _RUNS else ""
    task = _RUNS.get((pid, root))
    if task is not None:
        if not task.done():
            result = LoadResult(state=LoadState.RUNNING, project_id=pid, run=setup_run_address(pid, root), display=display,
                                phase=result.phase if result is not None else None)
        elif result is not None and result.state is LoadState.RUNNING:
            try:
                answer = task.result()
                if answer is None:
                    raise RuntimeError("The setup run returned no result")
                unmet = _unmet(answer, asset)
                ready = answer.ok and not unmet
                if ready:
                    _REPAIRED.discard((pid, asset))
                result = LoadResult(
                    state=LoadState.READY if ready else LoadState.FAILED, project_id=pid,
                    detail=answer.detail if ready else unmet or _leaf_failure(answer.root) or answer.detail,
                    run=setup_run_address(pid, root),
                    display=display, setup_available=not ready and (pid, asset) not in _REPAIRED, asset=asset or None,
                )
            except (Exception, asyncio.CancelledError) as exc:
                result = LoadResult(state=LoadState.FAILED, project_id=pid, detail=str(exc) or "Setup was cancelled", display=display)
            _keep(pid, asset, result)
    return result.model_copy(update={"asset": asset or None}) if result is not None else None


def _configuration_failure(node, target: str = "") -> str:
    """Unmet checks are pending; invalid declarations are failures even in check mode. A node that
    stands on its own and is not the one being shown keeps its trouble to itself."""
    if node is None or (node.independent and node.id != target):
        return ""
    if node.state in (SetupState.FAILED, SetupState.REFUSED):
        return node.detail
    return next((detail for child in node.children if (detail := _configuration_failure(child, target))), "")


def _leaf_failure(node) -> str:
    """The deepest step that failed, in its own words — a parent's "waiting on X" names nothing to fix."""
    if node is None:
        return ""
    deeper = next((detail for child in node.children if (detail := _leaf_failure(child))), "")
    if deeper:
        return deeper
    if node.state in (SetupState.FAILED, SetupState.REFUSED) and node.detail:
        return f"{node.label}: {node.detail}" if node.label else node.detail
    return ""


def _unmet(result, target: str) -> str:
    """Why the asset being shown is itself not ready, or ``""``. The tree settles without a web app that
    is not set up, so the one asked for is checked by name."""
    def find(node):
        if node is None or node.id == target:
            return node
        return next((hit for child in node.children if (hit := find(child)) is not None), None)

    node = find(result.root) if target else None
    if node is None or node.state in (SetupState.DONE, SetupState.SKIPPED):
        return ""
    return _leaf_failure(node) or (f"{node.label}: {node.detail}" if node.detail else f"{node.label} is not set up")


async def validate(pid: str, target: str, display: str = "") -> Optional[LoadResult]:
    """Phase one of an open: an app that answers where it runs opens as it is — no tree, no walk, no lock.
    None: load it. A running app is shown whatever its setup says (that is the next load's business). A
    display session needs this provider's READY for THAT display: its saved presentation is checked by a
    load, never assumed."""
    if not target.startswith("micro_app-"):
        return None
    kept = _RESULTS.get((pid, target))
    if kept is not None and kept.state is not LoadState.READY:
        return None
    if display and (kept is None or kept.display != display):
        return None
    from flow_sdk.builtin.webapp_setup import answers_now  # noqa: PLC0415

    try:
        if not await answers_now(target):
            return None
    except Exception as exc:  # noqa: BLE001 — a failed check is a load, never an error
        logger.debug("validate of %s failed: %s", target, exc)
        return None
    return kept or _keep(pid, target, LoadResult(state=LoadState.READY, project_id=pid, asset=target))


async def load_project(project: Any, *, approved: bool = False, asset: Any = None, tree: Any = None,
                       ancestors: tuple[str, ...] = (), display: str = "") -> LoadResult:
    """Check or start a provider's lifecycle; approval is explicit and never inferred from Add/Open.

    ``approved`` on a load that FAILED (``setup_available``) runs setup, then the load again: the screen
    showing an app sends it once, unasked — opening the app is the person saying "make it work"."""
    from flow_sdk.builtin.project_dependencies import required_projects
    from flow_sdk.builtin.project_setup import start_setup
    from flow_sdk.core.setup.derive import ProjectTree
    from flow_sdk.core.setup.execute import execute_setup

    pid = str(project.id)
    target = str(asset.typeid) if asset is not None else ""
    if pid in ancestors:
        return LoadResult(state=LoadState.FAILED, project_id=pid,
                          detail=f"The provider lifecycle has a dependency cycle: {' -> '.join((*ancestors, pid))}")
    on_disk = getattr(asset, "on_disk", None)
    if callable(on_disk) and not on_disk():
        # A stale row is no node of the tree, and a tree without it would settle as ready.
        gone = _keep(pid, target, LoadResult(
            state=LoadState.FAILED, project_id=pid, asset=target,
            detail=f"{getattr(asset, 'name', None) or target}'s folder is gone: {asset.asset_ref}"))
        return gone
    valid = await validate(pid, target, display) if not approved and not ancestors else None
    if valid is not None:
        return valid
    # Traverse before taking this provider's lock: opposite ends of a dependency
    # cycle may be loaded concurrently, and must never wait on each other's lock.
    try:
        providers = await required_projects(project) if hasattr(project, "dependencies") else []
        children = [await load_project(p, ancestors=(*ancestors, pid)) for p in providers]
    except Exception as exc:
        return _keep(pid, target, LoadResult(state=LoadState.FAILED, project_id=pid, detail=str(exc)))
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
            problem = _configuration_failure(prerequisites.root, target)
            if problem:
                raise ValueError(problem)
            missing = next((c for c in children if c.state is LoadState.SETUP_REQUIRED), None)
            unmet = _unmet(prerequisites, target)
            # Showing one app: only what THAT app needs holds it — nothing beside it ever blocks it.
            needs_setup = bool(unmet) if target else not prerequisites.ok or bool(unmet) or missing is not None
            if needs_setup and not approved:
                state = LoadState.FAILED if prerequisites.state is SetupState.REFUSED else LoadState.SETUP_REQUIRED
                result = LoadResult(state=state, project_id=pid,
                                    detail=missing.detail if missing else prerequisites.detail or unmet,
                                    tree=prerequisites.bare())
            else:
                operational = LoadTree(tree)
                running = await execute_setup(tree.root, resolve_node=operational.resolve_node,
                                               resolve_op=operational.resolve_op, **common) if not needs_setup else None
                # Showing one app: it is up, whatever the apps beside it are. Otherwise everything up, not
                # merely nothing held up — an app that is down still gets its load run, which starts it.
                loaded = running is not None and running.ok and (
                    not _unmet(running, target) if target else running.done == running.total)
                if loaded and all(c.state is LoadState.READY for c in children):
                    _REPAIRED.discard((pid, target))
                    result = LoadResult(state=LoadState.READY, project_id=pid)
                else:
                    # The load failed and the person said go: setup first (it redoes only what its own
                    # checks find missing), then the load again. Once — its failure is then the answer.
                    repair = approved and current is not None and current.setup_available
                    if repair:
                        _REPAIRED.add((pid, target))
                        needs_setup = True
                    # Showing one app: set up and start THAT app — the rest of the project (a credential
                    # nobody has given yet, an app beside it) is its own item and never holds this one.
                    run = await start_setup(project, root=target, tree=tree if needs_setup else operational,
                                            load_after=needs_setup, providers=providers,
                                            dependency_approval=approved, ancestors=(*ancestors, pid))
                    result = LoadResult(state=LoadState.RUNNING, project_id=pid, run=run,
                                        phase="setup" if needs_setup else "load")
        except Exception as exc:
            logger.warning("load of project %s failed: %s", pid, exc, exc_info=True)
            result = LoadResult(state=LoadState.FAILED, project_id=pid, detail=str(exc))
        return _keep(pid, target, result.model_copy(update={"display": display or None, "asset": target or None}))


async def bring_up(project: Any, *, asset: Any = None, display: str = "", wait: bool = False) -> LoadResult:
    """THE way an asset comes up, whoever asks — a screen, ``flow app open``, an agent's auto-open:
    validate (it answers: done) → load → setup when owed (one repair per failure) → the fixer when setup
    still fails. An app's owed setup runs unasked: opening it is the person saying "make it work". The
    project alone stops at SETUP_REQUIRED — its screen asks first. ``wait``: answer once the run it
    started has settled (a caller that reads where the app runs right after)."""
    from flow_sdk.builtin.project_setup import _RUNS  # noqa: PLC0415

    pid = str(project.id)
    last = load_state(pid, asset=str(asset.typeid) if asset is not None else "")
    # A load that already failed with setup untried goes straight to setup, never round the load again.
    result = last if last is not None and last.state is LoadState.FAILED and last.setup_available else (
        await load_project(project, asset=asset, display=display))
    owed = (result.state is LoadState.SETUP_REQUIRED and asset is not None) or (
        result.state is LoadState.FAILED and result.setup_available)
    if owed:
        result = await load_project(project, approved=True, asset=asset, display=display)
    if wait and result.state is LoadState.RUNNING:
        target = result.asset or ""
        task = _RUNS.get((pid, target)) or _RUNS.get((pid, ""))
        if task is not None:
            await asyncio.gather(task, return_exceptions=True)
        result = load_state(pid, asset=target) or result
        if result.state is LoadState.FAILED and result.setup_available:
            # The load failed: setup is the next step (once — its failure goes to the fixer).
            return await bring_up(project, asset=asset, display=display, wait=True)
    return result


async def load_asset(project: Any, asset: Any) -> LoadResult:
    """Display uses the same prerequisite gate as dependency Add and project Open."""
    if project is None:
        return LoadResult(state=LoadState.FAILED, project_id="", asset=str(asset.typeid),
                          detail="This asset has no local provider project")
    return await load_project(project, asset=asset)


__all__ = ["LoadTree", "bring_up", "forget", "load_asset", "load_project", "load_state", "validate"]
