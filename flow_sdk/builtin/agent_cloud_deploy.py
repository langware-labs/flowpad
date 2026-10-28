"""An agent's cloud deploy over HTTP (``POST agent/<id>/deploy``): the request, its steps, and the activity they run under.

The deploy is five plain steps (``DEPLOYMENT_STEPS``) — publish the agent, share its hub dependencies, plan its
placement on the hub, check readiness, have the hub place it on a machine — that know nothing of progress.
:func:`run_deployment_steps` runs them under the agent's ``deploy`` activity, each one a child of it: everything up
to readiness before it answers, so a refusal (a missing value, a publish problem) is the answer; the machine after,
the activity telling the screen how it goes.

Model funding never refuses a deploy (``requirement_spec.ADVISORY_KINDS``): a placement with nothing to spend is
placed all the same, and the readiness step says so.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, ClassVar, Optional

from pydantic import ConfigDict, field_validator

from flow_sdk.schema.data_spec.credential_contract import is_valid_environment
from flow_sdk.schema.data_spec.requirement_spec import REQUIREMENT_FUNDING
from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.schema.data_spec.token_allocation_spec import TokenAllocationSpec

if TYPE_CHECKING:
    from flow_sdk.builtin.agent import Agent
    from flow_sdk.builtin.deployment import Deployment
    from flow_sdk.fs_store.type_id import TypeId
    from flow_sdk.schema.data_spec.requirement_spec import ReadinessSpec

logger = logging.getLogger(__name__)

#: The activity a deploy reports on, under its agent.
DEPLOY_ACTIVITY = "deploy"

#: ``token_allocation`` not given: leave the deployment's as it is.
_UNSET = object()


class AgentDeployRequest(DataSpec):
    """Where to deploy an agent and how. ``provider``: ``local`` is this computer, any other the hub's name for a
    compute provider, empty the hub's default. ``environment``: the credential environment a cloud placement
    reads (empty: ``production``). ``token_allocation``: the placement's own budget — absent leaves it as it is,
    ``null`` releases it."""

    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "agent.deploy_request"

    provider: str = ""
    environment: Optional[str] = None
    token_allocation: Optional[TokenAllocationSpec] = None

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


class DeployRunning(RuntimeError):
    """A deploy of this agent is already running; a second would race it for the same placement."""


@dataclass
class DeployContext:
    """What one deploy's steps share: what was asked, then what the steps found. ``token_allocation`` keeps
    ``Agent.plan_deployment``'s meaning (omitted: unchanged)."""

    agent: "Agent"
    actor: "TypeId"
    environment: Optional[str]
    provider: Optional[str]
    token_allocation: Any
    deployment: Optional["Deployment"] = None
    ready: Optional["ReadinessSpec"] = None


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
    # Its ``hub:`` dependencies are fetched on the machine with the agent's own login.
    from flow_sdk.builtin.asset_publishing import owning_project  # noqa: PLC0415
    from flow_sdk.builtin.hub_dependencies import share_hub_dependencies  # noqa: PLC0415

    await share_hub_dependencies(ctx.agent, await owning_project(ctx.agent))


async def _plan(ctx: DeployContext) -> None:
    ctx.deployment = await ctx.agent.plan_deployment(
        ctx.environment, provider=ctx.provider, token_allocation=ctx.token_allocation
    )


async def _check_readiness(ctx: DeployContext) -> str:
    # The gate: the placement's store must hold every value the agent needs before a machine is paid for (the
    # hub checks the same names again). Funding is reported, never a refusal.
    from flow_sdk.builtin.readiness import NotReady, readiness  # noqa: PLC0415

    ctx.ready = await readiness(ctx.agent, ctx.deployment)
    if not ctx.ready.ready:
        raise NotReady(ctx.ready, ctx.deployment)
    return "; ".join(funding_warnings(ctx.agent, ctx.ready))


def funding_warnings(agent: "Agent", ready: "ReadinessSpec") -> list[str]:
    """The funding a deploy proceeds without, said to the person deploying: one sentence per missing item."""
    return [
        f"No LLM funding for {agent.name or agent.id}: {item.fix}"
        for item in ready.advisories()
        if item.requirement.kind == REQUIREMENT_FUNDING
    ]


async def _start_machine(ctx: DeployContext) -> None:
    from flow_sdk.builtin.cloud_deploy import deploy_entity_to_cloud, wait_until_placed  # noqa: PLC0415
    from flow_sdk.cloud_client.shared.errors import HubError  # noqa: PLC0415

    try:
        await deploy_entity_to_cloud(
            ctx.agent,
            ctx.environment,
            provider=ctx.provider,
            require=ctx.ready.value_names(),
            deployment_id=str(ctx.deployment.id),
        )
    except HubError as exc:
        # No answer at all (status 0): the load balancer in front of the hub dropped the request while the hub
        # went on placing the machine. Its push, mirrored into the placement's local row, is the answer.
        if exc.status_code != 0:
            raise
        await wait_until_placed(str(ctx.deployment.id))


DEPLOYMENT_STEPS = [
    # A deploy names an agent the hub has to already know.
    DeployStep("publish", "Publish the agent", lambda ctx: ctx.agent.ensure_on_hub(ctx.actor), inline=True),
    DeployStep("dependencies", "Share its dependencies", _share_dependencies, inline=True),
    DeployStep("plan", "Plan the deployment", _plan, inline=True),
    # The gate: a missing value refuses the deploy before a machine is paid for, as the request's answer.
    DeployStep("readiness", "Check what it needs", _check_readiness, inline=True),
    DeployStep("machine", "Start a machine", _start_machine),
]


async def run_deployment_steps(
    agent: "Agent",
    actor: "TypeId",
    environment: Optional[str] = None,
    *,
    provider: Optional[str] = None,
    token_allocation: Any = _UNSET,
) -> dict[str, Any]:
    """``DEPLOYMENT_STEPS`` under *agent*'s ``deploy`` activity, each as its child — running, then done or failed
    with its error — then the activity's end. The ``inline`` steps run first, a failure raised to the caller (and
    ending the activity); the rest run after this returns, a failure told only on the activity.

    The answer: where the activity reports, and the placement it lands on. Single-flight per agent: a deploy
    already running raises :class:`DeployRunning`.
    """
    from flow_sdk.activity import Activity  # noqa: PLC0415
    from flow_sdk.cloud_client.hub_proxy import DEPLOY_TIMEOUT  # noqa: PLC0415
    from flow_sdk.request_context.detached import create_detached_task  # noqa: PLC0415

    subject = str(agent.typeid)
    try:
        # Held for as long as the hub may take to place the machine; a holder past it is claimable again.
        root = Activity.try_claim(DEPLOY_ACTIVITY, subject_entity=subject, timeout_seconds=int(DEPLOY_TIMEOUT.read))
    except RuntimeError as exc:
        raise DeployRunning(f"{agent.name or agent.id} is already being deployed") from exc
    # The whole outline before any step starts: every step is on the screen, pending, at once.
    root.label(f"Deploy {agent.name or agent.id}").plan(
        [{"name": step.name, "label": step.label} for step in DEPLOYMENT_STEPS]
    )
    ctx = DeployContext(agent, actor, environment, provider, token_allocation)

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
            root.fail(str(exc) or type(exc).__name__)
            logger.warning("cloud deploy of %s failed: %s", subject, exc)
            return
        root.done()

    try:
        await run([step for step in DEPLOYMENT_STEPS if step.inline])
    except BaseException as exc:
        root.fail(str(exc) or type(exc).__name__)
        raise
    create_detached_task(
        run_after_the_answer([step for step in DEPLOYMENT_STEPS if not step.inline]), name=f"agent-deploy:{agent.id}"
    )
    return {
        "activity": {"path": DEPLOY_ACTIVITY, "subject_entity": subject},
        "deployment_id": str(ctx.deployment.id),
    }


__all__ = ["DEPLOY_ACTIVITY", "DEPLOYMENT_STEPS", "AgentDeployRequest", "DeployRunning", "run_deployment_steps"]
