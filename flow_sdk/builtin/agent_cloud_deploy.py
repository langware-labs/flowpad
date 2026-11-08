"""A project's cloud deploy over HTTP (``POST project/<id>/deploy``): the request, its steps, and the activity they run under.

A deployment places the whole PROJECT on a machine, with one optional main agent answering every call there.
The deploy is six plain steps (``DEPLOYMENT_STEPS``) — publish the project, share its hub dependencies, plan its
placement on the hub, store the values typed for it, check readiness, have the hub place it on a machine — that know nothing of progress.
:func:`run_deployment_steps` runs them under the project's ``deploy`` activity, each one a child of it: everything up
to readiness before it answers, so a refusal (a missing value, a publish problem) is the answer; the machine after,
the activity telling the screen how it goes.

Model funding never refuses a deploy (``requirement_spec.ADVISORY_KINDS``): a placement with nothing to spend is
placed all the same, and the readiness step says so.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, ClassVar, Literal, Optional

from pydantic import ConfigDict, Field, field_validator

from flow_sdk.schema.data_spec.credential_contract import is_valid_environment
from flow_sdk.schema.data_spec.requirement_spec import REQUIREMENT_FUNDING
from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.schema.data_spec.token_allocation_spec import TokenAllocationSpec

if TYPE_CHECKING:
    from flow_sdk.builtin.agent import Agent
    from flow_sdk.builtin.deployment import Deployment
    from flow_sdk.builtin.project import Project
    from flow_sdk.fs_store.type_id import TypeId
    from flow_sdk.schema.data_spec.requirement_spec import ReadinessSpec

logger = logging.getLogger(__name__)

#: The activity a deploy reports on, under its project.
DEPLOY_ACTIVITY = "deploy"

#: ``token_allocation`` not given: leave the deployment's as it is.
_UNSET = object()


class DeployRequest(DataSpec):
    """Where to deploy a project and how. ``provider``: ``local`` is this computer, any other the hub's name for a
    compute provider, empty the hub's default. ``environment``: the credential environment a cloud placement
    reads (empty: ``production``). ``token_allocation``: the placement's own budget — absent leaves it as it is,
    ``null`` releases it."""

    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "project.deploy_request"

    provider: str = ""
    environment: Optional[str] = None
    token_allocation: Optional[TokenAllocationSpec] = None
    #: The cloud box size for THIS deploy (``sm`` | ``md`` | ``lg``); empty: the main agent's ``machine_size``.
    #: Sent with the deploy, never written into agent.json: a deploy must not dirty the checkout it deploys.
    machine_size: Optional[Literal["sm", "md", "lg"]] = None
    #: The planned placement this deploy is for (the one a refused deploy named); empty: a new one.
    deployment_id: Optional[str] = None
    #: Values typed in the deploy dialog, ``{credential: {variable: value}}``: stored on the placement before
    #: the readiness gate, so one Launch is enough and an abandoned dialog leaves no row. Never logged.
    values: dict[str, dict[str, str]] = Field(default_factory=dict, repr=False)
    #: What to deploy: a tag, a release or a commit; ``source_ref`` names it (empty: the checkout's HEAD).
    source_kind: Literal["tag", "release", "commit"] = "commit"
    source_ref: Optional[str] = None
    #: The agent that answers on the box (``agent-<uuid>`` or its id); absent: the project's ``main_agent``
    #: recommendation; ``""`` (given, empty): no agent.
    main_agent_id: Optional[str] = None

    @field_validator("provider", mode="before")
    @classmethod
    def _stripped(cls, value: Any) -> str:
        return str(value or "").strip()

    @field_validator("environment", mode="before")
    @classmethod
    def _an_environment(cls, value: Any) -> Optional[str]:
        name = str(value or "").strip()
        if not name:
            return None
        if not is_valid_environment(name):
            raise ValueError(f"{name!r} is not a valid environment name")
        return name

    @property
    def allocation_given(self) -> bool:
        """Whether the request names a token allocation at all — ``null`` (release it) included."""
        return "token_allocation" in self.model_fields_set

    @property
    def main_agent_given(self) -> bool:
        return "main_agent_id" in self.model_fields_set


class DeployRunning(RuntimeError):
    """A deploy of this project is already running; a second would race it for the same placement."""


@dataclass
class DeployContext:
    """What one deploy's steps share: what was asked, then what the steps found. ``token_allocation`` keeps
    ``Project.plan_deployment``'s meaning (omitted: unchanged). ``agent`` is the main agent, or None."""

    project: "Project"
    agent: Optional["Agent"]
    actor: "TypeId"
    environment: Optional[str]
    provider: Optional[str]
    token_allocation: Any
    machine_size: Optional[str] = None
    #: The planned placement asked for; none: the plan makes a new one.
    deployment_id: Optional[str] = None
    deployment: Optional["Deployment"] = None
    ready: Optional["ReadinessSpec"] = None
    values: Optional[dict[str, dict[str, str]]] = field(default=None, repr=False)
    source_kind: str = "commit"
    source_ref: Optional[str] = None


@dataclass(frozen=True)
class DeployStep:
    """One step of the deploy: its child's name on the activity, how a screen reads it, and the work. A step that
    answers a string has it shown as its end. An ``inline`` step runs before the request is answered, so its
    refusal is the answer; the others run after it."""

    name: str
    label: str
    run: Callable[[DeployContext], Awaitable[object]]
    inline: bool = False


async def _share_dependencies(ctx: DeployContext) -> None:
    # Its ``hub:`` dependencies are fetched on the machine with the main agent's own login.
    from flow_sdk.builtin.hub_dependencies import share_hub_dependencies  # noqa: PLC0415

    if ctx.agent is not None:
        await share_hub_dependencies(ctx.agent, ctx.project)


async def _unplaced(ctx: DeployContext) -> Optional[str]:
    """This project's placement on the same provider and environment with the same main agent: a deploy
    continues it, planned or already on a machine, so its stored values and the triggers that run on it
    keep their deployment id. The hub brings a placed one's machine to the new commit in place."""
    from flow_sdk.builtin.cloud_deploy import DEFAULT_CLOUD_ENVIRONMENT, DEFAULT_CLOUD_PROVIDER  # noqa: PLC0415
    from flow_sdk.builtin.deployment import Deployment  # noqa: PLC0415

    row = await Deployment.find_existing(
        str(ctx.project.typeid),
        ctx.provider or DEFAULT_CLOUD_PROVIDER,
        environment=ctx.environment or DEFAULT_CLOUD_ENVIRONMENT,
    )
    if row is None:
        return None
    return str(row.id) if row.main_agent_id == _main_typeid(ctx) else None


def _main_typeid(ctx: DeployContext) -> Optional[str]:
    return str(ctx.agent.typeid) if ctx.agent is not None else None


async def _plan(ctx: DeployContext) -> None:
    # The hub makes a new placement for a plan that names none: a redeploy names the one it continues.
    from flow_sdk.cloud_client.shared.errors import HubError  # noqa: PLC0415

    async def plan(deployment_id: Optional[str]):
        return await ctx.project.plan_deployment(
            ctx.environment,
            provider=ctx.provider,
            token_allocation=ctx.token_allocation,
            deployment_id=deployment_id,
            main_agent=ctx.agent,
        )

    if ctx.deployment_id:
        ctx.deployment = await plan(ctx.deployment_id)
        return
    found = await _unplaced(ctx)
    try:
        ctx.deployment = await plan(found)
    except HubError as exc:
        # A row the hub no longer has (its placement was removed there) is not one to continue.
        if not found or exc.status_code != 404:
            raise
        # Dropped here too, or every later deploy would find it first and plan yet another placement.
        from flow_sdk.builtin.deployment import Deployment  # noqa: PLC0415

        await Deployment.mirror_hub_row({"id": found}, "delete")
        ctx.deployment = await plan(None)


async def _store_values(ctx: DeployContext) -> None:
    # Into the placement's own store, the one the readiness gate reads next.
    from flow_sdk.builtin.credential_service import set_credential_by_name  # noqa: PLC0415

    for credential, values in (ctx.values or {}).items():
        await set_credential_by_name(
            credential, values, project_id=str(ctx.project.id), deployment_id=str(ctx.deployment.id)
        )


async def _check_readiness(ctx: DeployContext) -> str:
    # The gate: the placement's store must hold every value the project and its main agent need before a
    # machine is paid for (the hub checks the same names again). Funding is reported, never a refusal.
    from flow_sdk.builtin.readiness import NotReady, readiness  # noqa: PLC0415

    ctx.ready = await readiness(ctx.agent, ctx.deployment, project=ctx.project)
    if not ctx.ready.ready:
        raise NotReady(ctx.ready, ctx.deployment)
    return "; ".join(funding_warnings(ctx.agent, ctx.ready)) if ctx.agent is not None else ""


def funding_warnings(agent: "Agent", ready: "ReadinessSpec") -> list[str]:
    """The funding a deploy proceeds without, said to the person deploying: one sentence per missing item."""
    return [
        f"No LLM funding for {agent.name or agent.id}: {item.fix}"
        for item in ready.advisories()
        if item.requirement.kind == REQUIREMENT_FUNDING
    ]


def dependency_blockers(data: Any) -> list[str]:
    """One sentence per required dependency the hub could not fetch, from its refusal's ``data.dependencies``:
    ``"<name>: <reason> — <fix>"``. Empty when the refusal is not about dependencies."""
    deps = data.get("dependencies") if isinstance(data, dict) else None
    out: list[str] = []
    for dep in deps if isinstance(deps, list) else []:
        if not isinstance(dep, dict) or not dep.get("required", True) or dep.get("state") == "ready":
            continue
        name = str(dep.get("name") or dep.get("source") or "dependency")
        reason = str(dep.get("reason") or dep.get("state") or "not ready")
        fix = str(dep.get("fix") or "")
        out.append(f"{name}: {reason}" + (f" — {fix}" if fix else ""))
    return out


async def _start_machine(ctx: DeployContext) -> None:
    from flow_sdk.builtin.cloud_deploy import deploy_entity_to_cloud, wait_until_placed  # noqa: PLC0415
    from flow_sdk.cloud_client.shared.errors import HubError  # noqa: PLC0415
    from flow_sdk.schema.data_spec.hub_failure_spec import HubFailureKind  # noqa: PLC0415

    try:
        await deploy_entity_to_cloud(
            ctx.project,
            ctx.environment,
            provider=ctx.provider,
            require=ctx.ready.value_names(),
            deployment_id=str(ctx.deployment.id),
            machine_size=ctx.machine_size or (getattr(ctx.agent, "machine_size", None) if ctx.agent else None),
            main_agent_id=_main_typeid(ctx),
            source_kind=ctx.source_kind,
            source_ref=ctx.source_ref,
        )
    except HubError as exc:
        # A transport failure (the load balancer dropped the answer): the hub's push into the local row is the answer.
        if exc.status_code == 0 and exc.kind is HubFailureKind.OFFLINE:
            logger.warning("deploy of %s lost the hub's answer (%s); waiting for its push", ctx.project.id, exc)
            await wait_until_placed(str(ctx.deployment.id))
            return
        if blockers := dependency_blockers(exc.data):
            # Said as what to do, not as a status code: the person deploying reads this.
            raise RuntimeError("Cannot deploy: " + "; ".join(blockers)) from exc
        raise


DEPLOYMENT_STEPS = [
    # A deploy names a project the hub has to already know, at the version being deployed: published every time
    # (a git-backed project pushes its HEAD — a no-op when the hub has it — or refuses uncommitted/unpushed work).
    DeployStep("publish", "Publish the project", lambda ctx: _publish(ctx), inline=True),
    DeployStep("dependencies", "Share its dependencies", _share_dependencies, inline=True),
    DeployStep("plan", "Plan the deployment", _plan, inline=True),
    DeployStep("values", "Store the values you typed", _store_values, inline=True),
    # The gate: a missing value refuses the deploy before a machine is paid for, as the request's answer.
    DeployStep("readiness", "Check what it needs", _check_readiness, inline=True),
    DeployStep("machine", "Start a machine", _start_machine),
]


async def _publish(ctx: DeployContext) -> None:
    await ctx.project.ensure_on_hub()
    if ctx.agent is not None:
        await ctx.agent.ensure_on_hub(ctx.actor, force=True)


async def _record_deploy_failed(deployment: "Deployment", reason: str) -> None:
    """The placement says it failed, and why: otherwise its row reads as if the machine were on its way."""
    deployment.status = deployment.status.model_copy(update={"sync_state": "error", "message": reason})
    await deployment.save()


async def _tell_deploy_failed(project: "Project", reason: str) -> None:
    """A deploy that failed after the request was answered is told to the person, not only logged."""
    from flow_sdk.notifications.desktop import notify_desktop  # noqa: PLC0415

    try:
        await notify_desktop(
            "deploy_failed", title=f"Deploy of {project.name or project.id} failed", body=reason, level="error"
        )
    except Exception:  # noqa: BLE001 -- the activity row still carries the failure
        logger.warning("could not tell the deploy failure of %s", project.id, exc_info=True)


async def run_deployment_steps(
    project: "Project",
    actor: "TypeId",
    main_agent: Optional["Agent"] = None,
    environment: Optional[str] = None,
    *,
    provider: Optional[str] = None,
    token_allocation: Any = _UNSET,
    machine_size: Optional[str] = None,
    deployment_id: Optional[str] = None,
    values: Optional[dict[str, dict[str, str]]] = None,
    source_kind: str = "commit",
    source_ref: Optional[str] = None,
) -> dict[str, Any]:
    """``DEPLOYMENT_STEPS`` under *project*'s ``deploy`` activity, each as its child — running, then done or failed
    with its error — then the activity's end. The ``inline`` steps run first, a failure raised to the caller (and
    ending the activity); the rest run after this returns, a failure told only on the activity. ``deployment_id``
    names the planned placement the deploy is for; none plans a new one.

    The answer: where the activity reports, and the placement it lands on. Single-flight per project: a deploy
    already running raises :class:`DeployRunning`.
    """
    from flow_sdk.activity import Activity  # noqa: PLC0415
    from flow_sdk.cloud_client.hub_proxy import DEPLOY_TIMEOUT  # noqa: PLC0415
    from flow_sdk.request_context.detached import create_detached_task  # noqa: PLC0415

    subject = str(project.typeid)
    try:
        # Held for as long as the hub may take to place the machine; a holder past it is claimable again.
        root = Activity.try_claim(DEPLOY_ACTIVITY, subject_entity=subject, timeout_seconds=int(DEPLOY_TIMEOUT.read))
    except RuntimeError as exc:
        raise DeployRunning(f"{project.name or project.id} is already being deployed") from exc
    # The whole outline before any step starts: every step is on the screen, pending, at once.
    root.label(f"Deploy {project.name or project.id}").plan(
        [{"name": step.name, "label": step.label} for step in DEPLOYMENT_STEPS]
    )
    ctx = DeployContext(
        project,
        main_agent,
        actor,
        environment,
        provider,
        token_allocation,
        machine_size,
        deployment_id,
        values=values,
        source_kind=source_kind,
        source_ref=source_ref,
    )

    async def run(steps: list[DeployStep]) -> None:
        for step in steps:
            node = root.child(step.name).label(step.label)
            try:
                message = await step.run(ctx)
            except BaseException as exc:
                node.fail(str(exc) or type(exc).__name__)
                raise
            node.done(message if isinstance(message, str) and message else None)

    async def run_after_the_answer(steps: list[DeployStep]) -> None:
        try:
            await run(steps)
        except BaseException as exc:
            reason = str(exc) or type(exc).__name__
            root.fail(reason)
            logger.warning("cloud deploy of %s failed: %s", subject, exc)
            await _record_deploy_failed(ctx.deployment, reason)
            await _tell_deploy_failed(project, reason)
            return
        root.done()

    try:
        await run([step for step in DEPLOYMENT_STEPS if step.inline])
    except BaseException as exc:
        root.fail(str(exc) or type(exc).__name__)
        raise
    create_detached_task(
        run_after_the_answer([step for step in DEPLOYMENT_STEPS if not step.inline]), name=f"project-deploy:{project.id}"
    )
    return {
        "activity": {"path": DEPLOY_ACTIVITY, "subject_entity": subject},
        "deployment_id": str(ctx.deployment.id),
    }


__all__ = [
    "DEPLOY_ACTIVITY",
    "DEPLOYMENT_STEPS",
    "DeployRequest",
    "DeployRunning",
    "dependency_blockers",
    "run_deployment_steps",
]
