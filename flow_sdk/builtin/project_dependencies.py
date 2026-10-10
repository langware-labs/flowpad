"""Project dependencies — ``flow.json`` resolved to folders on THIS machine.

The one owner of "which folders are in this project's context". A project declares
them in ``flow.json`` (``flow_sdk/schema/data_spec/flow_json_spec.py``); this module
turns each declaration into a local folder and keeps the project's folder links equal
to exactly the resolved set. Everything that reads a project's context —
``Project.include_dirs`` / ``context_roots`` (worker ``--add-dir``, the asset scan, the
home agent tiles, journeys, the help desk resolver) — reads those links, so it needs
no knowledge of ``flow.json`` at all. The links are a per-machine CACHE: private,
rebuilt from the file, never shared (the file is what travels).

Two kinds of entry, one walk. An entry is an ID (``<type>-<uuid>`` / ``<kind>.id.<uuid>``,
``flow_sdk/dependencies/resolve.py``: this machine, then the hub, else ``not_found``) or — in the
project's root file only — a LOCATION (``git+`` / ``hub:`` / ``file:``). The project declares in its
root file AND through every folder asset of its own that carries a ``flow.json``
(``agentic-assets/<family>/<name>/flow.json``): an asset it holds is an asset it depends on.

Resolution is breadth-first and transitive. A resolved dependency's own ``flow.json``
is followed — an id's in its asset folder, a location's at its root — with three rules
that keep a graph you do not control from doing harm:

* its ``optionalDependencies`` are skipped — optional is the declaring project's choice;
* its ``file:`` sources are ignored — a cloned repo must not mount ``~/.ssh`` for you;
* a node seen before (same origin) is not visited again, so a cycle ends, and the
  project itself is seen first, so a dependency that points back at it is a no-op.

Nothing here pulls a checkout the user made. A git dependency reuses the checkout it
finds as it is; only a clone this module made is fast-forwarded, and only on
``update=True``.
"""

from __future__ import annotations

import asyncio
import logging
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterable, Optional

from flow_sdk.assets import flow_json
from flow_sdk.fs_store.origin.fs_origin import safe_join
from flow_sdk.fs_store.path_utils import canonical_posix_path, is_path_under
from flow_sdk.schema.data_spec.flow_json_spec import (
    AssetFlowJsonSpec,
    DependencySource,
    DependencyState,
    FlowDependency,
    expand_file_target,
    parse_source,
)
from flow_sdk.stream_inbox._locks import keyed_loop_lock, new_registry

if TYPE_CHECKING:
    from flow_sdk.builtin.folder import Folder
    from flow_sdk.builtin.project import Project
    from flow_sdk.dependencies.resolve import Resolved

logger = logging.getLogger(__name__)

#: A graph bigger than this is a mistake or an attack, not a use case.
MAX_NODES = 32
#: Sidecar key naming the dependency a folder link stands for.
DEP_KEY = "dependency"

#: One resolve at a time per project: two would race on the same links and clones.
#: Weak-valued (``stream_inbox/_locks``): it lives only while a resolve holds or awaits it.
_LOCKS = new_registry()
#: The detached resolve a project's activation started, by project.
_TASKS: dict[str, "asyncio.Task"] = {}

#: The last fetch failure per ``(project_id, name, via)``: a status read (no network) has
#: nothing new to say about a dependency it did not try to fetch, so it repeats what the
#: last fetch found ("repository not found") instead of a vaguer "not here yet".
_LAST_FAILURE: dict[tuple[str, str, Optional[str]], tuple[str, str]] = {}

#: ``(project_id, dependency name)`` whose missing-dependency warning was dismissed.
#: Process memory on purpose: "don't show again until Flowpad restarts".
_DISMISSED: set[tuple[str, str]] = set()


def dismiss(project_id: str, name: str) -> None:
    _DISMISSED.add((str(project_id), name))


def is_dismissed(project_id: str, name: str) -> bool:
    return (str(project_id), name) in _DISMISSED


@dataclass
class _Found:
    """A materialized dependency: its folder entity and the asset root on disk."""

    #: None for an id with nothing to link: a value, a single-file asset, or an asset already
    #: inside the project (``path`` then says where it is).
    folder: Optional["Folder"]
    path: Optional[str]
    origin_kind: str
    transportable: bool
    cloned: bool = False
    note: Optional[str] = None
    #: An id entry: what it resolved to (its TypeId, and where its own flow.json lives).
    resolved: Optional["Resolved"] = None


class _NotReady(Exception):
    def __init__(self, state: str, reason: str) -> None:
        super().__init__(reason)
        self.state = state
        self.reason = reason


# ── sources → folders ───────────────────────────────────────────────────────


async def _github_token() -> Optional[str]:
    try:
        from flow_sdk.app.actions.oauth_action import _get_github_token_for_current_user  # noqa: PLC0415

        return await _get_github_token_for_current_user()
    except Exception:  # noqa: BLE001 — anonymous is a valid way to read a public repo
        return None


def _checkout_for(origin: Any, cached: Optional[str]) -> Optional[Path]:
    """A local checkout of ``origin``'s repo: the folder's cached path first (where the
    user added it from — any location, any branch), then one found by URL."""
    from flow_sdk.utils.git import find_local_repo_for_url, find_project_root  # noqa: PLC0415

    if cached and Path(cached).is_dir():
        repo = find_project_root(cached)
        if repo and origin.matches_checkout(Path(repo)):
            return Path(repo)
    local = find_local_repo_for_url(origin.clone_url())
    if local and origin.matches_checkout(Path(local)):
        return Path(local)
    return None


async def _git(dep: FlowDependency, url: str, branch: str, *, fetch: bool, update: bool, cloned: bool) -> _Found:
    import asyncio  # noqa: PLC0415

    from flow_sdk.builtin.faas.git_repo import GitRepo  # noqa: PLC0415
    from flow_sdk.builtin.folder import Folder  # noqa: PLC0415
    from flow_sdk.fs_store.origin.git_origin import GitOrigin  # noqa: PLC0415
    from flow_sdk.utils.git import git_clone, git_current_branch  # noqa: PLC0415

    origin = GitOrigin.from_url(url, branch=branch, rel_path=dep.path)
    if origin is None:
        raise _NotReady("invalid", f"not a recognizable git URL: {url}")
    folder = await Folder.mint_for_origin(origin)
    cached_root: Optional[str] = None
    if folder.path:
        # ``folder.path`` is the asset root (repo + path); walk back to the repo.
        cached_root = folder.path
    repo = await asyncio.to_thread(_checkout_for, origin, cached_root)
    made = False
    if repo is None:
        if not fetch:
            raise _NotReady("missing", "not on this machine yet — sync to fetch it")
        target = await asyncio.to_thread(origin.next_clone_target)
        result = await git_clone(origin.clone_url(), str(target), branch=branch or None, token=await _github_token())
        if not result.ok:
            raise _NotReady("unreachable", f"could not clone {origin.clone_url()}: {result.detail}")
        repo, made = target, True
    elif update and cloned:
        pulled = await (await GitRepo.local(str(repo))).pull(branch=branch or None)
        if not pulled.ok:
            logger.info("[deps] pull %s for %s: %s", pulled.kind, repo, pulled.message)
    root = safe_join(repo, dep.path) if dep.path != "." else repo
    if root is None or not root.is_dir():
        raise _NotReady("invalid", f"{dep.path!r} is not a folder in {origin.clone_url()}")
    note = None
    if branch:
        current = await asyncio.to_thread(git_current_branch, str(repo))
        if current and current != branch:
            note = f"the checkout is on branch {current}; flow.json asks for {branch}"
    path = canonical_posix_path(str(root))
    if folder.path != path:
        folder.path = path
        await folder.save()
    return _Found(folder, path, "git", True, cloned=made or cloned, note=note)


async def _file(target: str, base: Path) -> _Found:
    from flow_sdk.builtin.folder import Folder  # noqa: PLC0415

    path = expand_file_target(target, base=base)
    if not path.is_dir():
        raise _NotReady("missing", f"{path} is not a folder on this machine")
    canonical = canonical_posix_path(str(path))
    folder = await Folder.mint_for_path(canonical)
    return _Found(folder, canonical, "local", False)


async def _hub(dep: FlowDependency, project_id: str, *, fetch: bool, update: bool, cloned: bool) -> _Found:
    """A hub project: its row names where its files live (``git_origin``) — the
    project's hosted repository, or its own git remote."""
    from flow_sdk.cloud_client.shared.errors import HubError  # noqa: PLC0415
    from flow_sdk.cloud_client.transport.hub_http import hub_get_or_raise  # noqa: PLC0415
    from flow_sdk.fs_store.origin.field import ORIGIN_ADAPTER  # noqa: PLC0415
    from flow_sdk.fs_store.origin.git_origin import GitOrigin  # noqa: PLC0415
    from flow_sdk.fs_store.origin.hub_repo_origin import HubRepoOrigin  # noqa: PLC0415
    from flow_sdk.db.drivers.db_base_record import BuiltinEntityType  # noqa: PLC0415

    if not fetch:
        raise _NotReady("missing", "not on this machine yet — sync to fetch it")
    try:
        row = await hub_get_or_raise(BuiltinEntityType.PROJECT, project_id)
    except HubError as exc:
        from flow_sdk.dependencies.resolve import hub_reason  # noqa: PLC0415

        status = getattr(exc, "status_code", 0)
        reason = "this hub project does not exist" if status == 404 else hub_reason(status)
        raise _NotReady("unreachable", reason) from exc
    data = row.get("data", row) if isinstance(row, dict) else {}
    origin = ORIGIN_ADAPTER.validate_python(data.get("git_origin")) if data.get("git_origin") else None
    if isinstance(origin, GitOrigin):
        return await _git(dep, origin.clone_url(), origin.branch, fetch=fetch, update=update, cloned=cloned)
    if not isinstance(origin, HubRepoOrigin):
        raise _NotReady("unreachable", "this hub project has no files to fetch (it was never pushed)")
    from flow_sdk.builtin.drivers.hub_repo_driver import HubRepoOriginDriver  # noqa: PLC0415
    from flow_sdk.builtin.folder import Folder  # noqa: PLC0415

    origin = origin.model_copy(update={"rel_path": dep.path})
    folder = await Folder.mint_for_origin(origin)
    try:
        repo, _ = await HubRepoOriginDriver().materialize(origin)
    except Exception as exc:  # noqa: BLE001 — the driver's message names the failure
        raise _NotReady("unreachable", str(exc)) from exc
    root = safe_join(Path(repo), dep.path) if dep.path != "." else Path(repo)
    if root is None or not root.is_dir():
        raise _NotReady("invalid", f"{dep.path!r} is not a folder in that hub project")
    path = canonical_posix_path(str(root))
    if folder.path != path:
        folder.path = path
        await folder.save()
    return _Found(folder, path, "hub_repo", True, cloned=True)


async def _materialize(dep: FlowDependency, base: Path, *, fetch: bool, update: bool, cloned: bool) -> _Found:
    source = dep.parsed
    if source.kind == "git":
        return await _git(dep, source.target, source.branch, fetch=fetch, update=update, cloned=cloned)
    if source.kind == "hub":
        return await _hub(dep, source.target, fetch=fetch, update=update, cloned=cloned)
    return await _file(source.target, base)


async def _ref(
    project: "Project", dep: FlowDependency, source: DependencySource, via: Optional[str], root: Path, *, fetch: bool, rows: dict
) -> _Found:
    """An id entry: resolved here, else on the hub (whose project holding it is fetched here and
    indexed, so its rows exist), else :class:`_NotReady`. Nothing is linked for an id with no folder
    of its own (a value, a single-file asset, a record source) or one already inside the project."""
    from flow_sdk.builtin.folder import Folder  # noqa: PLC0415
    from flow_sdk.dependencies.resolve import NotResolved, resolve_ref  # noqa: PLC0415
    from flow_sdk.fs_store.type_id import TypeId  # noqa: PLC0415

    async def fetch_project(project_id: str) -> None:
        found = await _hub(FlowDependency(name=dep.name, source=f"hub:{project_id}"), project_id, fetch=True, update=False, cloned=False)
        from flow_sdk.builtin.agentic_process.agentic_process import _index_additional_dir  # noqa: PLC0415

        await _index_additional_dir(found.path, read_only=True, project_id=None)

    try:
        resolved = await resolve_ref(source, near=root, rows=rows, fetch=fetch, fetch_project=fetch_project)
    except NotResolved as exc:
        raise _NotReady(exc.state, exc.reason) from exc
    path = canonical_posix_path(resolved.context) if resolved.context else None
    if path is None or is_path_under(path, canonical_posix_path(str(root))):
        return _Found(None, path, "local", False, resolved=resolved)
    # The link from the last resolve names this folder already: minting again would re-detect its
    # origin (git subprocesses) on every status read.
    link = _link_for(project, dep.name, via)
    same = link is not None and link[1].get("path") == path
    folder = (await Folder.get_by_id(TypeId(link[0]).id) if same else None) or await Folder.mint_for_path(path)
    cloned = resolved.fetched or bool(same and link[1].get("cloned"))
    return _Found(folder, path, "local", False, cloned=cloned, resolved=resolved)


def _sidecar(found: _Found, dep: FlowDependency, via: Optional[str], own: bool) -> dict:
    """What a dependency's folder link remembers — the per-machine cache a status read answers from."""
    data = {
        "path": found.path,
        "origin_kind": found.origin_kind,
        DEP_KEY: dep.name,
        "source": dep.source,
        "subpath": dep.path,
        "via": via,
        "own": own,
        "required": dep.required,
        "cloned": found.cloned,
        "read_only": found.transportable,
    }
    if found.resolved is not None:
        data["typeid"] = found.resolved.typeid
    return data


def _declared_by(found: _Found) -> tuple[list[FlowDependency], Path]:
    """What a resolved dependency itself depends on, and the folder its entries are relative to. An
    id's own file is read strictly (:class:`flow_json.FlowJsonError`): it was written to be followed.
    A location's root file is read the way a project's is on open — a broken one declares nothing."""
    if found.resolved is None:
        return flow_json.read(Path(found.path)).entries(), Path(found.path)
    folder = found.resolved.declares
    declared = flow_json.read_strict(folder, found.resolved.spec) if folder is not None else None
    return (declared.entries() if declared else []), folder or Path()


def _identity(dep: FlowDependency, base: Path) -> str:
    """What makes two declarations the SAME dependency, without touching the network."""
    source = dep.parsed
    if source.kind == "ref":
        from flow_sdk.dependencies.resolve import typeid_of  # noqa: PLC0415

        return f"ref:{typeid_of(source)}"
    if source.kind == "git":
        from flow_sdk.fs_store.origin.git_origin import GitOrigin  # noqa: PLC0415

        origin = GitOrigin.from_url(source.target, rel_path=dep.path)
        return f"git:{origin.key()}" if origin else f"git:{source.target}:{dep.path}"
    if source.kind == "hub":
        return f"hub:{source.target}:{dep.path}"
    return f"file:{canonical_posix_path(str(expand_file_target(source.target, base=base)))}"


def _own_identities(root: Path, project_id: Optional[str] = None) -> set[str]:
    """The project's own identities, so a dependency pointing back at it is a no-op."""
    out = {f"file:{canonical_posix_path(str(root))}"}
    if project_id:
        out.add(f"ref:project-{project_id}")
    try:
        from flow_sdk.fs_store.origin.git_origin import GitOrigin  # noqa: PLC0415

        own = GitOrigin.for_asset_path(str(root))
        if own is not None:
            out.add(f"git:{GitOrigin.from_url(own.clone_url(), rel_path='.').key()}")
    except Exception:  # noqa: BLE001
        pass
    return out


# ── the resolver ────────────────────────────────────────────────────────────


def _links(project: "Project") -> dict[str, dict]:
    """The project's folder links: typeid → sidecar."""
    return {str(tid): dict(project.get_context_entry_data(tid) or {}) for tid in project.context_of_type("folder", bucket="both")}


def _installed_optionals(project: "Project") -> set[str]:
    return {
        data[DEP_KEY]
        for data in _links(project).values()
        # Declared by the project itself — its root file or one of its own assets (``own``; a link
        # written before that flag existed is the root file's when it has no ``via``).
        if data.get(DEP_KEY) and data.get("own", not data.get("via")) and data.get("required") is False
    }


def _link_for(project: "Project", name: str, via: Optional[str]) -> Optional[tuple[str, dict]]:
    """The current link standing for dependency ``name`` (declared ``via``), if any."""
    for tid, data in _links(project).items():
        if data.get(DEP_KEY) == name and data.get("via") == via:
            return tid, data
    return None


def _was_cloned(project: "Project", name: str, via: Optional[str]) -> bool:
    link = _link_for(project, name, via)
    return bool(link and link[1].get("cloned"))


async def _from_link(project: "Project", dep: FlowDependency, via: Optional[str]) -> Optional[_Found]:
    """A status read's answer for a dependency resolved before: its link, while the
    folder is still there and still the same source. No network, no git."""
    from flow_sdk.builtin.folder import Folder  # noqa: PLC0415
    from flow_sdk.fs_store.type_id import TypeId  # noqa: PLC0415

    link = _link_for(project, dep.name, via)
    if link is None:
        return None
    tid, data = link
    if data.get("source") != dep.source or data.get("subpath", ".") != dep.path or data.get("required") != dep.required:
        return None
    if not data.get("path") or not Path(data["path"]).is_dir():
        return None
    folder = await Folder.get_by_id(TypeId(tid).id)
    if folder is None:
        return None
    return _Found(folder, data["path"], str(data.get("origin_kind") or "local"), bool(data.get("read_only")), bool(data.get("cloned")))


def safe_name(raw: str) -> str:
    """A dependency name from a folder or repo leaf: allowed characters only."""
    import re  # noqa: PLC0415

    name = re.sub(r"[^A-Za-z0-9._-]+", "-", str(raw or "")).strip("-._")
    return (name or "dependency")[:64]


async def resolve(
    project: "Project",
    *,
    fetch: bool = True,
    install: Iterable[str] = (),
    update: bool = False,
    index: bool = True,
) -> list[DependencyState]:
    """Resolve ``flow.json`` and make the project's folder links match. Returns one state per dependency.

    ``fetch=False`` never touches the network (no clone, no hub call) — what a status read
    uses. ``install`` names optional dependencies to bring in. ``update`` fast-forwards the
    clones this module made.
    """
    root_str = getattr(project, "fs_storage_mount_path", None)
    if not root_str:
        return []
    lock = keyed_loop_lock(_LOCKS, str(project.id))
    async with lock:
        return await _resolve(project, Path(root_str), fetch=fetch, install=install, update=update, index=index)


def is_resolving(project_id: str) -> bool:
    """A background resolve (the one opening a project starts) is still running."""
    running = _TASKS.get(str(project_id))
    return running is not None and not running.done()


def schedule_resolve(project: "Project") -> None:
    """Resolve in the background (fetching), at most one run per project. Opening a
    project calls this; the links it writes reach the UI through the project's own update."""
    pid = str(project.id)
    running = _TASKS.get(pid)
    if running is not None and not running.done():
        return

    async def run() -> None:
        try:
            from flow_sdk.builtin.project import Project  # noqa: PLC0415

            fresh = await Project.get_by_id(pid) or project
            await resolve(fresh, fetch=True)
        except Exception:  # noqa: BLE001 — a background resolve reports through states, never raises
            logger.warning("[deps] background resolve failed for %s", pid, exc_info=True)

    _TASKS[pid] = asyncio.get_running_loop().create_task(run())


async def _resolve(
    project: "Project", root: Path, *, fetch: bool, install: Iterable[str], update: bool, index: bool
) -> list[DependencyState]:
    try:
        spec = flow_json.read_strict(root)
    except flow_json.FlowJsonError as exc:
        # A broken file declares nothing — but it must not tear down what resolved before.
        return [DependencyState(name="flow.json", source="", state="invalid", reason=str(exc))]
    spec = spec or flow_json.FlowJsonSpec()
    wanted_optionals = _installed_optionals(project) | set(install)
    pid, root_canon = str(project.id), canonical_posix_path(str(root))

    states: list[DependencyState] = []
    desired: dict[str, tuple["Folder", dict]] = {}
    seen = _own_identities(root, pid)
    declared_by: dict[str, str] = {}
    rows: dict = {}   # dataset rows, read once for every value id this walk resolves
    # (entry, base, own, via_path): ``own`` = declared by this project — its root file or one of its
    # own assets — so its optional entries count; a dependency's own optionals never do.
    queue: deque[tuple[FlowDependency, Path, bool, list[str]]] = deque((d, root, True, []) for d in spec.entries())
    for label, entries, problem in _own_asset_entries(root):
        if problem:
            states.append(DependencyState(name=label, source="", state="invalid", reason=problem, via=label, via_path=[label]))
            continue
        queue.extend((d, root, True, [label]) for d in entries)
    visited = 0
    while queue:
        dep, base, own, via_path = queue.popleft()
        if not own and not dep.required:
            continue
        via = via_path[-1] if via_path else None
        source, key = dep.parsed, (pid, dep.name, via)

        def state(name: str, **kw: Any) -> DependencyState:
            return DependencyState(
                name=dep.name, source=dep.source, required=dep.required, path=dep.path, via=via, state=name,
                via_path=list(via_path), label=dep.label, description=dep.description, **kw,
            )

        if via is not None and source.kind == "file":
            states.append(state("invalid", reason=f"ignored: a file: source is honoured only in a project's own {flow_json.FLOW_JSON}"))
            continue
        if not dep.required and dep.name not in wanted_optionals:
            failed = _LAST_FAILURE.get(key)
            # An install that was tried and failed says why; one never tried is just waiting.
            states.append(state(failed[0], reason=failed[1]) if failed else state("not_installed"))
            continue
        identity = _identity(dep, base)
        if identity in seen:
            # Transitively a repeat is the normal shape of a graph (a diamond, a cycle).
            # Declared twice in THIS project's own file it is a mistake worth naming.
            if via is None:
                first = declared_by.get(identity)
                states.append(state("invalid", reason=(
                    f"the same source as {first!r}" if first else "this is the project itself"
                )))
            continue
        seen.add(identity)
        declared_by[identity] = dep.name if via is None else f"{via}/{dep.name}"
        if visited >= MAX_NODES:
            states.append(state("invalid", reason=f"more than {MAX_NODES} dependencies; the rest were not resolved"))
            break
        visited += 1
        try:
            if source.kind == "ref":
                found = await _ref(project, dep, source, via, root, fetch=fetch, rows=rows)
            else:
                found = None if (fetch and update) else await _from_link(project, dep, via)
                if found is None:
                    found = await _materialize(dep, base, fetch=fetch, update=update, cloned=_was_cloned(project, dep.name, via))
        except _NotReady as exc:
            if fetch:
                _LAST_FAILURE[key] = (exc.state, exc.reason)
            elif key in _LAST_FAILURE and exc.state == "missing":
                # Not fetched now; the last fetch said why it could not be.
                states.append(state(*_LAST_FAILURE[key][:1], reason=_LAST_FAILURE[key][1]))
                continue
            states.append(state(exc.state, reason=exc.reason))
            continue
        except Exception as exc:  # noqa: BLE001 — one dependency never breaks the rest
            logger.warning("[deps] %s failed", dep.name, exc_info=True)
            if fetch:
                _LAST_FAILURE[key] = ("unreachable", str(exc))
            states.append(state("unreachable", reason=str(exc)))
            continue
        _LAST_FAILURE.pop(key, None)
        # A LOCATION inside the project is a mistake; an ID that names one of the project's own
        # assets is simply already in its context (``_ref`` returns it with nothing to link).
        if found.resolved is None and is_path_under(found.path, root_canon):
            states.append(state("invalid", reason="a dependency cannot be inside the project itself"))
            continue
        states.append(state(
            "ready", local_path=found.path, reason=found.note, typeid=found.resolved.typeid if found.resolved else None,
        ))
        if found.folder is not None:
            desired[str(found.folder.typeid)] = (found.folder, _sidecar(found, dep, via, own))
        try:
            children, child_base = _declared_by(found)
        except flow_json.FlowJsonError as exc:
            states.append(state("invalid", reason=f"{found.resolved.typeid}: {exc}"))
            continue
        queue.extend((child, child_base, False, via_path + [dep.name]) for child in children)

    states = [s.model_copy(update={"dismissed": True}) if is_dismissed(pid, s.name) and s.state != "ready" else s for s in states]
    added = await _reconcile(project, desired)
    if index:
        await _index(project, [desired[tid] for tid in added])
    return states


def _own_asset_entries(root: Path) -> list[tuple[str, list[FlowDependency], Optional[str]]]:
    """``(label, entries, problem)`` for every folder asset of the project that carries a
    ``flow.json`` — found where each folder-backed type is placed (``agentic-assets/<family>/``,
    ``.claude/skills/`` …), never by a path spelled here. ``label`` is ``<family>/<name>``,
    ``problem`` why its file could not be read."""
    from flow_sdk.assets.scope import folder_backed_types  # noqa: PLC0415

    out: list[tuple[str, list[FlowDependency], Optional[str]]] = []
    mounts = sorted({mount for info in folder_backed_types() for mount in info.scan_mounts})
    for mount in mounts:
        family = root / mount
        if not family.is_dir():
            continue
        for folder in sorted(p for p in family.iterdir() if (p / flow_json.FLOW_JSON).is_file()):
            label = f"{family.name}/{folder.name}"
            try:
                declared = flow_json.read_strict(folder, AssetFlowJsonSpec)
            except flow_json.FlowJsonError as exc:
                out.append((label, [], str(exc)))
                continue
            if declared is not None:
                out.append((label, declared.entries(), None))
    return out


async def _reconcile(project: "Project", desired: dict[str, tuple["Folder", dict]]) -> list[str]:
    """Make the project's folder links equal ``desired`` (order kept). Returns the newly linked typeids."""
    current = _links(project)
    changed = False
    stale = [tid for tid in project.context_of_type("folder", bucket="both") if str(tid) not in desired]
    if stale:
        project.remove_shared_context_entities(*stale)
        project.remove_private_context_entities(*stale)
        changed = True
    added: list[str] = []
    for tid, (folder, data) in desired.items():
        if current.get(tid) != data:
            if tid in current:
                project.remove_shared_context_entities(folder.typeid)
                project.remove_private_context_entities(folder.typeid)
            project.add_private_context_entities(folder.typeid, data=data)
            changed = True
            if (current.get(tid) or {}).get("path") != data["path"]:
                added.append(tid)
    if changed:
        await project.save()
    return added


async def _index(project: "Project", linked: list[tuple["Folder", dict]]) -> None:
    """Index newly linked roots. Rows found in a folder that is itself a project's mount
    belong to THAT project; anything else belongs to the project that depends on it."""
    if not linked:
        return
    from flow_sdk.builtin.agentic_process.agentic_process import _index_additional_dir  # noqa: PLC0415
    from flow_sdk.fs_store.indexer.roots import deepest_project_id_for_path, load_project_mounts  # noqa: PLC0415

    mounts = await load_project_mounts()
    for _folder, data in linked:
        owner = deepest_project_id_for_path(data["path"], mounts, default=str(project.id))
        await _index_additional_dir(data["path"], read_only=bool(data.get("read_only")), project_id=owner)


# ── authoring ───────────────────────────────────────────────────────────────


async def declaration_for_path(path: str) -> tuple[str, str, str]:
    """``(name, source, path)`` for a folder on disk: inside a git repo it is the repo
    (``git+<url>#<branch>``, ``path`` = where in it); otherwise ``file:<path>``.

    A git folder's Folder entity remembers ``path`` as where that repository lives on
    THIS machine, so resolving reuses the checkout the user added it from — wherever it
    is, on whatever branch — instead of cloning a second copy."""
    from flow_sdk.builtin.folder import Folder  # noqa: PLC0415

    canonical = canonical_posix_path(path)
    origin = await Folder.detect_origin(canonical)
    if origin.kind == "git":
        url = origin.clone_url()  # type: ignore[attr-defined]
        branch = getattr(origin, "branch", "") or ""
        rel = (origin.rel_path or ".").strip("/") or "."
        folder = await Folder.mint_for_origin(origin.model_copy(update={"rel_path": rel}), local_path=canonical)
        if folder.path != canonical:
            folder.path = canonical
            await folder.save()
        name = (getattr(origin, "name", "") if rel == "." else rel.rsplit("/", 1)[-1]) or Path(canonical).name
        return name, f"git+{url}" + (f"#{branch}" if branch else ""), rel
    return Path(canonical).name, f"file:{canonical}", "."


def default_name(source: str) -> str:
    """A name for an entry declared without one: an id's type and the head of its uuid, a repo or
    folder's leaf, a hub project's id head."""
    parsed = parse_source(source)
    if parsed.kind == "ref":
        return f"{parsed.ref_type.replace('.', '-')}-{parsed.ref_id[:8]}"
    if parsed.kind == "hub":
        return f"hub-{parsed.target[:8]}"
    return parsed.target.rstrip("/").rsplit("/", 1)[-1].removesuffix(".git")


async def add_to_asset(
    project: "Project", asset: str, source: str, *, name: Optional[str] = None, label: Optional[str] = None,
    description: Optional[str] = None, optional: bool = False,
) -> DependencyState:
    """Declare ``source`` (an id) in ``asset``'s own ``flow.json``, then resolve ``project``. The
    answer is the entry as ``project`` reaches it — or, when it does not reach that asset at all,
    a ``not_installed`` state saying so."""
    from flow_sdk.dependencies.resolve import NotResolved, resolve_local  # noqa: PLC0415

    target = parse_source(asset)
    if target.kind != "ref":
        raise ValueError(f"{asset!r} is not an asset id (<type>-<uuid>)")
    try:
        holder = await resolve_local(target, near=Path(project.fs_storage_mount_path))
    except NotResolved as exc:
        raise ValueError(exc.reason) from exc
    if holder is None or holder.declares is None:
        raise ValueError(f"{asset} is not a folder asset on this machine — only a folder asset declares dependencies")
    if holder.spec.locations:
        raise ValueError(f"{asset} is a project: declare it in the project's own flow.json")
    dep = FlowDependency(
        name=name or safe_name(default_name(source)), source=source.strip(), required=not optional,
        label=label or None, description=description or None,
    )
    try:
        flow_json.write_dependency(holder.declares, dep, AssetFlowJsonSpec)
    except flow_json.FlowJsonError as exc:
        raise ValueError(str(exc)) from exc
    states = await resolve(project, fetch=True, install=[dep.name] if optional else ())
    found = next((s for s in states if s.name == dep.name and s.source == dep.source), None)
    return found or DependencyState(
        name=dep.name, source=dep.source, required=dep.required, state="not_installed", label=dep.label,
        description=dep.description, reason=f"declared in {asset}, which this project does not depend on",
    )


def requirement_key(state: DependencyState) -> str:
    """What setup and ``flow dep check`` call a dependency: its name when the project's own file
    declares it, else the id (or source) it names — a name is unique only in the file it sits in.
    ``flow dep check`` (``cli/commands/dep_cmd.py``) applies the same rule to the wire rows."""
    return state.name if state.via is None else state.source


def warnings_for(project_id: str, states: list[DependencyState]) -> list[DependencyState]:
    """Required dependencies that could not be brought here and were not dismissed — what the
    open dialog lists. A transitive one counts too: the project needs what its dependencies need."""
    return [
        s for s in states
        if s.required and not s.dismissed and (s.state in ("missing", "unreachable", "not_found") or (s.via is None and s.state == "invalid"))
    ]


__all__ = [
    "DEP_KEY",
    "safe_name",
    "MAX_NODES",
    "add_to_asset",
    "declaration_for_path",
    "default_name",
    "requirement_key",
    "dismiss",
    "is_dismissed",
    "resolve",
    "warnings_for",
]
