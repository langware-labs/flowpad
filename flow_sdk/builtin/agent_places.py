"""Where an agent runs, and how it runs there.

A *place* is a Deployment of the agent: this computer (the local placement) or
a cloud machine. The definition (agent.json) is shared by every place; a place may
override its launch settings, be switched off on its own, own schedules
(``runs_on`` on the trigger) and be the one place that answers the agent's email
(``email_place``). All of these live in agent.json keyed by Deployment id, so they
travel with the definition and each machine applies only the entries naming a
placement that runs there.

A choice made here is written as a FIELD PATCH to agent.json through the same
revision-safe document writer the editor uses, then the row is re-read from disk.
Never ``agent.save()``: the row does not carry every file-owned field (the
system prompt body among them), and a full re-render from it erased the prompt.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

from flow_sdk.builtin.agent_schedule import ScheduleError, agent_folder
from flow_sdk.schema.data_spec.agent_spec import PLACE_OVERRIDABLE_FIELDS, AgentPlaceSpec

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.agent import Agent
    from flow_sdk.builtin.deployment import Deployment

logger = logging.getLogger(__name__)


class PlaceError(ScheduleError):
    """A place request the caller has to fix. ``status_code`` rides to HTTP."""


async def place_of(agent: "Agent", deployment_id: str, *, local: bool = False) -> "Optional[Deployment]":
    """The Deployment ``deployment_id`` when it places THIS agent, else None.

    ``local`` also requires that it runs on this machine — the one rule for "does
    this place's schedule, email or launch belong here".
    """
    from flow_sdk.builtin.deployment import Deployment  # noqa: PLC0415

    if not deployment_id:
        return None
    deployment = await Deployment.get_by_id(str(deployment_id))
    if deployment is None or deployment.parent_type_id != str(agent.typeid):
        return None
    if local and not deployment.is_local:
        return None
    return deployment.with_element(agent)


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
    patch = DocumentPatch(set_fields=set_fields, drop_fields=drop_fields)
    await asyncio.to_thread(update_document, document, patch)
    await reindex_paths([str(document)], mint=False)


# ── git probes ────────────────────────────────────────────────────────────


def _agent_repo(agent: "Agent") -> Optional[tuple[str, str]]:
    """(repository root, the agent's folder relative to it), or None outside a checkout."""
    from flow_sdk.utils.git import find_project_root  # noqa: PLC0415

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


def version_state(agent: "Agent") -> dict[str, Any]:
    """What the definition on this computer has that its published version lacks.

    ``pending_changes`` counts uncommitted paths under the agent's folder plus
    commits touching it since the published commit. Blocking (git); call it off
    the event loop.
    """
    from flow_sdk.utils.git import _sync  # noqa: PLC0415

    published_commit = str(getattr(agent.origin, "head_commit", "") or "")
    state: dict[str, Any] = {
        "published": bool(agent.remote and published_commit),
        "published_commit": published_commit,
        "has_repo": False,
        "pending_changes": 0,
    }
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
    # Unset keeps the legacy rule, reported as this computer: the machine asking is the one polling.
    answering = agent.email_place or (local.id if local is not None else None)
    published = str(getattr(agent.origin, "head_commit", "") or "")
    cloud = [d for d in deployments if not d.is_local]
    repo = await asyncio.to_thread(_agent_repo, agent) if cloud and published else None
    counts = await asyncio.gather(*(asyncio.to_thread(behind_count, d.source_revision, published, repo) for d in cloud))
    behind = dict(zip((d.id for d in cloud), counts))

    last_active = dict(zip((d.id for d in deployments), await asyncio.gather(*(_last_active(d) for d in deployments))))

    rows = []
    for deployment in deployments:
        place = agent.place_for(deployment.id)
        rows.append(
            {
                "deployment": deployment,
                "is_local": deployment.is_local,
                "overrides": place.overrides() if place is not None else {},
                "enabled": agent.enabled_on(deployment.id),
                "schedule_count": sum(
                    1
                    for t in schedules
                    if (t.runs_on or "") == deployment.id or (not t.runs_on and deployment.is_local)
                ),
                "answers_email": answering == deployment.id,
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
    return getattr(deployment.status, "observed_at", None) or None


async def email_answers_here(agent_id: str) -> bool:
    """Whether THIS machine should poll and answer the agent's mailbox."""
    from flow_sdk.builtin.agent import Agent  # noqa: PLC0415

    agent = await Agent.get_by_id(str(agent_id or ""))
    if agent is None or not agent.email_place:
        return True
    return await place_of(agent, agent.email_place, local=True) is not None


# ── writing the places ────────────────────────────────────────────────────


async def _write_place(agent: "Agent", deployment_id: str, field: str, value: Any) -> "Agent":
    """Set one field of one place's entry in agent.json; an entry left with nothing to say is dropped."""
    places = [p for p in agent.places or [] if p.deployment_id != deployment_id]
    current = agent.place_for(deployment_id)
    data = current.model_dump() if current is not None else {"deployment_id": deployment_id}
    data[field] = value
    updated = AgentPlaceSpec.model_validate(data)
    if updated.overrides() or updated.enabled is not None:
        places.append(updated)
    # No `places: []` in the file: an empty list is dropped from the header.
    if places:
        await _write_header(agent, {"places": [p.model_dump(exclude_none=True) for p in places]}, ())
    else:
        await _write_header(agent, {}, ("places",))
    agent.places = places or None
    return agent


async def set_place_override(agent: "Agent", deployment_id: str, field: str, value: Any) -> "Agent":
    """Set (or with ``value=None`` clear) one launch-setting override for one place; writes agent.json."""
    await _require_place(agent, deployment_id)
    if field not in PLACE_OVERRIDABLE_FIELDS:
        raise PlaceError(f"{field!r} cannot be overridden per place; one of {', '.join(PLACE_OVERRIDABLE_FIELDS)}")
    if value is not None:
        if field == "mcp_servers":
            if not isinstance(value, list) or not all(isinstance(v, str) and v.strip() for v in value):
                raise PlaceError("mcp_servers must be a list of server names")
            value = [v.strip() for v in value]
        else:
            value = str(value).strip() or None
    return await _write_place(agent, deployment_id, field, value)


async def set_place_enabled(agent: "Agent", deployment_id: str, enabled: Any) -> "Agent":
    """Switch the agent on or off on one place; ``None`` follows the definition's ``enabled``. Writes agent.json."""
    await _require_place(agent, deployment_id)
    if enabled is not None and not isinstance(enabled, bool):
        raise PlaceError("enabled must be true or false")
    return await _write_place(agent, deployment_id, "enabled", enabled)


async def set_email_place(agent: "Agent", deployment_id: str) -> "Agent":
    """Make one place the only one answering this agent's email; writes agent.json.

    Stops this machine's poller first when the answer moves elsewhere, so the
    hand-over never has two machines answering.
    """
    from flow_sdk.builtin.agent_mailbox import email_source_for_agent  # noqa: PLC0415
    from flow_sdk.builtin.data_source import SourceStatus  # noqa: PLC0415

    deployment = await _require_place(agent, deployment_id)
    source = await email_source_for_agent(agent.id)
    if source is not None and not deployment.is_local and source.status == SourceStatus.ACTIVE.value:
        source.status = SourceStatus.DISABLED.value
        await source.save_runtime()

    await _write_header(agent, {"email_place": deployment.id}, ())
    agent.email_place = deployment.id

    if source is not None and deployment.is_local and source.status == SourceStatus.DISABLED.value:
        source.status = SourceStatus.ACTIVE.value
        source.next_poll_at = None
        await source.save_runtime()
    return agent


async def adopt_placement(agent: "Agent", deployment_id: str, environment: str | None = None) -> "Deployment":
    """Make this machine's placement of ``agent`` carry the hub's id for it.

    Called ON a cloud machine by the hub at deploy and update. The box minted its
    own local placement; the definition's place entries (overrides, ``runs_on``,
    ``email_place``) name the hub's id. One placement, one id everywhere — so the
    row is re-keyed here rather than translating ids at every read.

    ``environment`` is the placement's credential environment. It is stamped on
    the row and becomes this instance's default, so plain terminals on the box
    read the same environment as its agent runs.
    """
    from flow_sdk.api.api_types.identifier import is_valid_entity_id  # noqa: PLC0415
    from flow_sdk.builtin.deployment import Deployment  # noqa: PLC0415
    from flow_sdk.instance_settings.environment import set_default_environment  # noqa: PLC0415
    from flow_sdk.schema.data_spec.credential_contract import normalize_environment  # noqa: PLC0415

    deployment_id = str(deployment_id or "").strip()
    if not is_valid_entity_id(deployment_id):
        raise PlaceError("deployment_id must be a UUID v4 or v5")
    try:
        env = normalize_environment(environment) if environment is not None else None
    except ValueError as e:
        raise PlaceError(str(e)) from e
    existing = await Deployment.get_by_id(deployment_id)
    if existing is not None:
        if existing.parent_type_id != str(agent.typeid):
            raise PlaceError(f"{deployment_id} places a different element", status_code=409)
        if not existing.is_local:
            raise PlaceError(f"{deployment_id} is not a placement on this machine", status_code=409)
        if env is not None and existing.environment != env:
            existing.environment = env
            await existing.save()
        adopted = existing
    else:
        current = await agent.local_deployment()
        adopted = await current.rekey(deployment_id, **({"environment": env} if env is not None else {}))
    if env is not None:
        set_default_environment(env)
    return adopted.with_element(agent)
