"""Where an agent runs, and how it runs there.

A *place* of an agent is a Deployment of its project whose ``main_agent_id`` is the agent: this
computer's local deployment or a cloud machine. The definition (agent.json) is shared by every
place; a place's launch overrides live on the deployment row (``main_agent_overrides``), never in
git, and a place owns the schedules whose trigger ``runs_on`` names it.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

from flow_sdk.builtin.agent_schedule import ScheduleError, agent_folder
from flow_sdk.schema.data_spec.agent_spec import PLACE_OVERRIDABLE_FIELDS

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.agent import Agent
    from flow_sdk.builtin.deployment import Deployment

logger = logging.getLogger(__name__)


class PlaceError(ScheduleError):
    """A place request the caller has to fix. ``status_code`` rides to HTTP."""


async def place_of(agent: "Agent", deployment_id: str, *, local: bool = False) -> "Optional[Deployment]":
    """The Deployment ``deployment_id`` when THIS agent is its main agent, else None.

    ``local`` also requires that it runs on this machine — the one rule for "does
    this place's schedule, email or launch belong here".
    """
    from flow_sdk.builtin.deployment import Deployment  # noqa: PLC0415

    if not deployment_id:
        return None
    deployment = await Deployment.get_by_id(str(deployment_id))
    if deployment is None or deployment.main_agent_id != str(agent.typeid):
        return None
    if local and not deployment.is_local:
        return None
    return deployment.with_agent(agent)


async def _require_place(agent: "Agent", deployment_id: str) -> "Deployment":
    deployment = await place_of(agent, deployment_id)
    if deployment is None:
        raise PlaceError(f"{deployment_id or '(none)'} is not a place this agent runs on", status_code=404)
    return deployment


async def _write_header(agent: "Agent", set_fields: dict[str, Any], drop_fields: tuple[str, ...]) -> None:
    """Patch the agent's document (its fields) in place and re-read the row from the file."""
    from flow_sdk.assets.document import DocumentPatch, update_document  # noqa: PLC0415
    from flow_sdk.fs_store.reindex import reindex_paths  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415
    from flow_sdk.schema.types import EntityType  # noqa: PLC0415

    document = Path(agent_folder(agent)) / SchemaRegistry.get(EntityType.AGENT.value).shape.main
    if not document.is_file():
        raise PlaceError(f"{document} does not exist", status_code=409)
    await asyncio.to_thread(update_document, document, DocumentPatch(set_fields=set_fields, drop_fields=drop_fields))
    await reindex_paths([str(document)], mint=False)


# ── git probes ────────────────────────────────────────────────────────────


def _hub_mirror(origin) -> Optional[tuple[str, str]]:
    """(this machine's mirror of the hub repo, the agent's path in it) for a hub-repo ``origin``."""
    from flow_sdk.assets.hub_repo_sync import mirror_root  # noqa: PLC0415

    if origin is None or not origin.rel_path:
        return None
    root = mirror_root(origin.repo_id)
    return (str(root), origin.rel_path) if (root / ".git").is_dir() else None


def hub_origin(agent: "Agent"):
    """The agent's hub-repo origin (see ``hub_origin_of``)."""
    from flow_sdk.assets.hub_repo_sync import hub_origin_of  # noqa: PLC0415

    try:
        folder = Path(agent_folder(agent))
    except ScheduleError:
        folder = None
    return hub_origin_of(agent, folder)


def _agent_repo(agent: "Agent") -> Optional[tuple[str, str]]:
    """(repository root, the agent's folder relative to it), or None outside a checkout.

    For an agent published into its project's hub repo that is this machine's
    mirror of it — the commits a cloud machine runs are that repo's commits.
    """
    from flow_sdk.utils.git import find_project_root  # noqa: PLC0415

    hub = _hub_mirror(hub_origin(agent))
    if hub is not None:
        return hub
    try:
        folder = Path(agent_folder(agent))
    except ScheduleError:
        return None
    root = find_project_root(str(folder)) if folder.exists() else None
    if not root:
        return None
    return root, str(folder.resolve().relative_to(Path(root).resolve()))


def _count(root: str, revisions: str, rel: str) -> Optional[int]:
    """Commits in ``revisions`` touching ``rel``, or None when git cannot say."""
    from flow_sdk.utils.git import _sync  # noqa: PLC0415

    count = _sync(root, "rev-list", "--count", revisions, "--", rel)
    return int(count) if count.isdigit() else None


def behind_count(
    source_revision: Optional[str],
    published_commit: str,
    repo: Optional[tuple[str, str]],
) -> Optional[int]:
    """Published commits touching the agent's folder that a cloud machine does not run yet.

    ``repo`` is ``_agent_repo(agent)``. None when it cannot be known here:
    nothing published, the machine never recorded its revision, or the agent
    is not in a checkout on this computer. Blocking (git); call it off the
    event loop.
    """
    if not source_revision or not published_commit:
        return None
    if source_revision == published_commit:
        return 0
    return _count(repo[0], f"{source_revision}..{published_commit}", repo[1]) if repo else None


def _project_checkout_state(agent: "Agent", hub: Optional[tuple[str, str]]):
    """The agent's project folder as a git checkout (``git_source_state``), or None when it is not one."""
    from flow_sdk.assets.hub_repo_sync import git_source_state  # noqa: PLC0415

    if hub is not None:
        root: Optional[Path] = Path(agent_folder(agent)).resolve().parents[len(Path(hub[1]).parts) - 1]
    else:
        repo = _agent_repo(agent)
        root = Path(repo[0]) if repo else None
    return git_source_state(root) if root is not None and root.is_dir() else None


def version_state(agent: "Agent") -> dict[str, Any]:
    """What the definition on this computer has that its published version lacks.

    In a project that is a git checkout (``git_native``) the checkout is what deploys:
    ``uncommitted`` paths and, with a remote of its own, ``unpushed`` commits are pending
    — a deploy refuses them. Otherwise ``pending_changes`` counts uncommitted paths under
    the agent's folder plus commits touching it since the published commit. Blocking (git); call it off
    the event loop.
    """
    from flow_sdk.utils.git import _sync  # noqa: PLC0415

    published_commit = str(getattr(agent.origin, "head_commit", "") or "")
    state: dict[str, Any] = {
        "published": bool(agent.remote and published_commit),
        "published_commit": published_commit,
        "has_repo": False,
        "git_native": False,
        "pending_changes": 0,
    }
    published = hub_origin(agent)
    hub = _hub_mirror(published)
    git = _project_checkout_state(agent, hub)
    if git is not None:
        # A git checkout is what deploys (``sync_project_with_hub``): what is not committed — and,
        # with a remote of its own, not pushed — is what a deploy would refuse, so it is what is pending.
        unpushed = git.unpushed or 0
        state.update(
            has_repo=True,
            git_native=True,
            has_remote=git.remote,
            uncommitted=len(git.uncommitted),
            unpushed=unpushed,
            pending_changes=len(git.uncommitted) + unpushed,
        )
        if published is not None:
            state.update(published=True, published_commit=published.head_commit)
        return state
    if hub is not None:
        # Published into the project's hub repo: the local folder either still matches
        # the published version (its tree) or it has changes to publish.
        from flow_sdk.assets.hub_repo_sync import local_tree  # noqa: PLC0415

        mirror, rel = hub
        worktree = Path(agent_folder(agent)).resolve().parents[len(Path(rel).parts) - 1]
        current = local_tree(Path(mirror), worktree, rel)
        state["has_repo"] = True
        state["published"] = True
        state["published_commit"] = published.head_commit
        state["pending_changes"] = 0 if current == published.tree else 1
        return state
    repo = _agent_repo(agent)
    if repo is None:
        return state
    root, rel = repo
    state["has_repo"] = True
    dirty = [line for line in _sync(root, "status", "--porcelain", "--", rel).splitlines() if line.strip()]
    # Never published: every commit touching the folder is unpublished.
    ahead = _count(root, f"{published_commit}..HEAD" if published_commit else "HEAD", rel) or 0
    state["pending_changes"] = len(dirty) + ahead
    return state


# ── reading the places ────────────────────────────────────────────────────


async def list_places(agent: "Agent") -> list[dict[str, Any]]:
    """Every place this agent runs on — this computer first — with what each owns."""
    from flow_sdk.builtin.trigger import Trigger  # noqa: PLC0415
    from flow_sdk.schema.data_spec.trigger_types import TriggerType  # noqa: PLC0415

    # Listing places never creates one: this computer is a deployment only once it was launched here.
    placed, triggers = await asyncio.gather(
        agent.deployments(),
        Trigger.get_all({"match": {"parent_type_id": str(agent.typeid)}}),
    )
    local = next((d for d in placed if d.is_local), None)
    deployments = ([local] if local is not None else []) + [d for d in placed if d is not local]
    schedules = [t for t in triggers if t.trigger_type == TriggerType.SCHEDULE]
    published = str(getattr(agent.origin, "head_commit", "") or "")
    cloud = [d for d in deployments if not d.is_local]
    repo = await asyncio.to_thread(_agent_repo, agent) if cloud and published else None
    counts = await asyncio.gather(*(asyncio.to_thread(behind_count, d.source_revision, published, repo) for d in cloud))
    behind = dict(zip((d.id for d in cloud), counts))

    last_active = dict(zip((d.id for d in deployments), await asyncio.gather(*(_last_active(d) for d in deployments))))

    rows = []
    for deployment in deployments:
        rows.append(
            {
                "deployment": deployment,
                "is_local": deployment.is_local,
                "overrides": dict(deployment.main_agent_overrides or {}),
                "enabled": bool(agent.enabled),
                "schedule_count": sum(
                    1
                    for t in schedules
                    if (t.runs_on or "") == deployment.id or (not t.runs_on and deployment.is_local)
                ),
                "behind": behind.get(deployment.id),
                "last_active": last_active.get(deployment.id),
            }
        )
    return rows


async def _last_active(deployment) -> str | None:
    """When this place last did something: its newest run here, else the last time the machine was
    seen (a cloud place's runs live on its own box). ISO time, or ``None`` when it never has."""
    if deployment.is_local:
        from flow_sdk.builtin.agentic_process import AgenticProcess  # noqa: PLC0415

        newest = await AgenticProcess.local_rows(
            {"match": {"deployment_id": deployment.id}, "order_by": {"updated_date": "desc"}, "limit": 1}
        )
        stamp = getattr(newest[0], "updated_date", None) if newest else None
        return stamp.isoformat() if hasattr(stamp, "isoformat") else (str(stamp) if stamp else None)
    # A cloud place's runs live on its box: its newest conversation is when it last did something.
    # A box the hub cannot read (paused, unreachable) answers with when it was last seen instead.
    try:
        data = await deployment._read_remote("threads", {})
        stamps = [t.get("last_at") for t in (data.get("threads") or []) if isinstance(t, dict) and t.get("last_at")]
        if stamps:
            return max(stamps)
    except Exception:  # noqa: BLE001 — a listing must not fail over a decoration
        pass
    return getattr(deployment.status, "observed_at", None) or None


async def email_answers_here(agent_id: str) -> bool:
    """Whether THIS machine should poll and answer the agent's mailbox: it has a local deployment
    whose main agent this is, or the agent is the main agent of no deployment at all."""
    from flow_sdk.builtin.agent import Agent  # noqa: PLC0415

    agent = await Agent.get_by_id(str(agent_id or ""))
    if agent is None:
        return True
    placed = await agent.deployments()
    return not placed or any(d.is_local for d in placed)


# ── writing the places ────────────────────────────────────────────────────


async def set_place_override(agent: "Agent", deployment_id: str, field: str, value: Any) -> "Agent":
    """Set (or with ``value=None`` clear) one launch-setting override of the main agent on one deployment;
    written on the deployment row."""
    deployment = await _require_place(agent, deployment_id)
    if field not in PLACE_OVERRIDABLE_FIELDS:
        raise PlaceError(f"{field!r} cannot be overridden per place; one of {', '.join(PLACE_OVERRIDABLE_FIELDS)}")
    if value is not None:
        if field == "mcp_servers":
            if not isinstance(value, list) or not all(isinstance(v, str) and v.strip() for v in value):
                raise PlaceError("mcp_servers must be a list of server names")
            value = [v.strip() for v in value]
        else:
            value = str(value).strip() or None
    overrides = {k: v for k, v in (deployment.main_agent_overrides or {}).items() if k != field}
    if value is not None:
        overrides[field] = value
    deployment.main_agent_overrides = overrides
    await deployment.save()
    return agent


async def _project_here(record: dict[str, Any]):
    """The project on this machine a hub deployment places. The machine indexes the cloned repo as its
    own project under its own id, which the record carries as ``project_id``; the hub's ``parent_type_id``
    is that id only when the project was shared from this machine."""
    from flow_sdk.builtin.project import Project  # noqa: PLC0415

    for candidate in (record.get("project_id"), str(record.get("parent_type_id") or "").removeprefix("project-")):
        if candidate and (project := await Project.get_by_id(str(candidate))) is not None:
            return project
    return None


async def adopt_deployment(record: dict[str, Any]) -> "Deployment":
    """``POST deployment/<id>/adopt`` on a cloud machine: make this machine's local deployment of the
    record's project carry the hub's id, main agent and environment. One deployment, one id everywhere —
    the row is re-keyed rather than translating ids at every read. Serving when it has a main agent.

    The environment becomes this instance's default, so plain terminals on the box read the same
    environment as its agent runs."""
    from flow_sdk.api.api_types.identifier import is_valid_entity_id  # noqa: PLC0415
    from flow_sdk.builtin.deployment import Deployment  # noqa: PLC0415
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.instance_settings.environment import set_default_environment  # noqa: PLC0415
    from flow_sdk.schema.data_spec.credential_contract import normalize_environment  # noqa: PLC0415

    deployment_id = str(record.get("id") or "").strip()
    if not is_valid_entity_id(deployment_id):
        raise PlaceError("deployment id must be a UUID v4 or v5")
    parent = str(record.get("parent_type_id") or "")
    if not parent.startswith("project-"):
        raise PlaceError("a deployment to adopt places a project", status_code=400)
    try:
        env = normalize_environment(record["environment"]) if record.get("environment") else None
    except ValueError as e:
        raise PlaceError(str(e)) from e
    main = str(record.get("main_agent_id") or "") or None
    changes: dict[str, Any] = {
        "main_agent_id": main,
        "main_agent_overrides": dict(record.get("main_agent_overrides") or {}),
        "identity": record.get("identity") or ("agent" if main else "none"),
        "serving": bool(main),
        **{k: record[k] for k in ("source_kind", "source_ref", "source_revision") if record.get(k)},
        **({"environment": env} if env is not None else {}),
    }
    existing = await Deployment.get_by_id(deployment_id)
    project = await _project_here(record)
    if existing is not None:
        if project is None or existing.parent_type_id != str(project.typeid):
            raise PlaceError(f"{deployment_id} places a different project", status_code=409)
        if not existing.is_local:
            raise PlaceError(f"{deployment_id} is not a deployment on this machine", status_code=409)
        # The hub's record, verbatim -- not a client PUT: a cleared main agent (None) must clear it here too.
        for name, value in changes.items():
            setattr(existing, name, value)
        await existing.save()
        adopted = existing
    else:
        if project is None:
            raise PlaceError(f"project {parent} is not on this machine", status_code=404)
        current = await project.local_deployment()
        adopted = current if str(current.id) == deployment_id else await current.rekey(deployment_id, **changes)
    if env is not None:
        set_default_environment(env)
    return adopted
