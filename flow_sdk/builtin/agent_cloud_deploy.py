"""An agent's cloud deploy: the steps it takes, and how a request runs them while a screen watches.

Two layers, kept apart on purpose:

* :class:`CloudDeploy` — the deploy itself, as five plain steps sharing one state: publish the agent,
  share its hub dependencies, plan its placement on the hub, check readiness, have the hub place it on
  a machine. Nothing here reports progress; ``Agent.deploy_to_cloud`` runs the steps back to back.
* :func:`run_cloud_deploy` — the deploy under its activity (``deploy`` on the agent), each step one of
  its children. The request is answered as soon as the activity is claimed and every step runs after
  it: the activity is what tells the screen how it goes, a refusal (a missing value, a publish problem)
  included. A deploy that waits runs them all before answering (``flow agent deploy``).

Model funding never refuses a deploy (``requirement_spec.ADVISORY_KINDS``): a placement with nothing to
spend is placed all the same, and the answer of a deploy that waits carries the warning.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Optional

from flow_sdk.builtin.agent import _UNSET

if TYPE_CHECKING:
    from flow_sdk.activity import Activity
    from flow_sdk.builtin.agent import Agent
    from flow_sdk.builtin.deployment import Deployment
    from flow_sdk.fs_store.type_id import TypeId
    from flow_sdk.schema.data_spec.requirement_spec import ReadinessSpec

logger = logging.getLogger(__name__)

#: The activity a deploy reports on, under its agent.
DEPLOY_ACTIVITY = "deploy"


class DeployRunning(RuntimeError):
    """A deploy of this agent is already running; a second would race it for the same placement."""


@dataclass(frozen=True)
class DeployStep:
    """One step of the deploy: its child's name on the activity, how a screen reads it, and the work."""

    name: str
    label: str
    run: Callable[[], Awaitable[None]]


class CloudDeploy:
    """One cloud deploy of *agent*, as the steps it takes. Each step reads and writes this state; nothing
    in it reports progress. ``token_allocation`` keeps ``plan_deployment``'s meaning (omitted: unchanged)."""

    def __init__(
        self,
        agent: "Agent",
        actor: "TypeId",
        environment: Optional[str] = None,
        *,
        provider: Optional[str] = None,
        token_allocation: Any = _UNSET,
    ) -> None:
        self.agent = agent
        self.actor = actor
        self.environment = environment
        self.provider = provider
        self.token_allocation = token_allocation
        self.deployment: Optional["Deployment"] = None
        self.readiness: Optional["ReadinessSpec"] = None
        #: The hub's answer once the machine is placed: the adopted deployment, its endpoints, its secrets.
        self.result: dict[str, Any] = {}

    def steps(self) -> list[DeployStep]:
        return [
            DeployStep("publish", "Publish the agent", self._publish),
            DeployStep("dependencies", "Share its dependencies", self._dependencies),
            DeployStep("plan", "Plan the deployment", self._plan),
            DeployStep("readiness", "Check what it needs", self._readiness),
            DeployStep("machine", "Start a machine", self._machine),
        ]

    async def run(self) -> dict[str, Any]:
        """Every step, back to back — the deploy with nobody watching. The hub's answer."""
        for step in self.steps():
            await step.run()
        return self.result

    @property
    def warnings(self) -> list[str]:
        """What the placement runs without — its model funding — once readiness has been asked."""
        from flow_sdk.builtin.readiness import funding_warnings  # noqa: PLC0415

        return funding_warnings(self.agent, self.readiness) if self.readiness is not None else []

    # ── the steps ─────────────────────────────────────────────────────────

    async def _publish(self) -> None:
        # A deploy names an agent the hub has to already know.
        await self.agent.ensure_on_hub(self.actor)

    async def _dependencies(self) -> None:
        # Its ``hub:`` dependencies are fetched on the machine with the agent's own login.
        from flow_sdk.builtin.asset_publishing import owning_project  # noqa: PLC0415
        from flow_sdk.builtin.hub_dependencies import share_hub_dependencies  # noqa: PLC0415

        await share_hub_dependencies(self.agent, await owning_project(self.agent))

    async def _plan(self) -> None:
        self.deployment = await self.agent.plan_deployment(
            self.environment, provider=self.provider, token_allocation=self.token_allocation
        )

    async def _readiness(self) -> None:
        # The gate: the placement's store must hold every value the agent needs before a machine is paid
        # for (the hub checks the same names again). Funding is reported, never a refusal.
        from flow_sdk.builtin.readiness import NotReady, readiness  # noqa: PLC0415

        self.readiness = await readiness(self.agent, self.deployment)
        if not self.readiness.ready:
            raise NotReady(self.readiness, self.deployment)

    async def _machine(self) -> None:
        from flow_sdk.builtin.cloud_deploy import deploy_entity_to_cloud, wait_until_placed  # noqa: PLC0415
        from flow_sdk.cloud_client.hub_bridge import deployment_pushes  # noqa: PLC0415
        from flow_sdk.cloud_client.shared.errors import HubError  # noqa: PLC0415

        assert self.readiness is not None and self.deployment is not None, "the plan and readiness run first"
        # Heard from before the deploy is sent: the hub pushes the placement as it gives it its machine.
        with deployment_pushes(str(self.deployment.id)) as pushed:
            try:
                self.result = await deploy_entity_to_cloud(
                    self.agent, self.environment, provider=self.provider, require=self.readiness.value_names()
                )
            except HubError as exc:
                # No answer at all (status 0): the load balancer in front of the hub dropped the request while
                # the hub went on placing the machine. Its push is the answer.
                if exc.status_code != 0:
                    raise
                self.result = await wait_until_placed(pushed)


async def run_cloud_deploy(deploy: CloudDeploy, *, background: bool) -> dict[str, Any]:
    """Run *deploy* under its activity: every step after this returns when *background*, before it otherwise.
    A step that fails ends the activity failed; it is raised here when not *background*, and in the background
    the activity is the only one told.

    The answer: the agent, and where its activity reports.

    Single-flight per agent: a deploy already running raises :class:`DeployRunning`.
    """
    from flow_sdk.activity import Activity  # noqa: PLC0415
    from flow_sdk.cloud_client.hub_proxy import DEPLOY_TIMEOUT  # noqa: PLC0415
    from flow_sdk.request_context.detached import create_detached_task  # noqa: PLC0415

    agent = deploy.agent
    subject = str(agent.typeid)
    try:
        # Held for as long as the hub may take to place the machine; a holder past it is claimable again.
        root = Activity.try_claim(DEPLOY_ACTIVITY, subject_entity=subject, timeout_seconds=int(DEPLOY_TIMEOUT.read))
    except RuntimeError as exc:
        raise DeployRunning(f"{agent.name or agent.id} is already being deployed") from exc
    steps = deploy.steps()
    # The whole outline before any step starts: every step is on the screen, pending, at once.
    root.label(f"Deploy {agent.name or agent.id}").plan([{"name": step.name, "label": step.label} for step in steps])
    accepted = {"agent_id": str(agent.id), "activity": {"path": DEPLOY_ACTIVITY, "subject_entity": subject}}
    if background:
        create_detached_task(_run_steps(root, steps), name=f"agent-deploy:{agent.id}")
    else:
        await _run_steps(root, steps, reraise=True)
    return accepted


async def _run_steps(root: "Activity", steps: list[DeployStep], *, reraise: bool = False) -> None:
    """*steps* in order, each as its child of *root* — running, then done or failed with its error — then
    *root*'s end: done, or failed with the failing step's error."""
    try:
        for step in steps:
            node = root.child(step.name).label(step.label)
            try:
                await step.run()
            except BaseException as exc:
                node.fail(str(exc) or type(exc).__name__)
                raise
            node.done()
    except BaseException as exc:
        root.fail(str(exc) or type(exc).__name__)
        if reraise:
            raise
        logger.warning("cloud deploy of %s failed: %s", root.subject_entity, exc)
        return
    root.done()


__all__ = ["DEPLOY_ACTIVITY", "CloudDeploy", "DeployRunning", "run_cloud_deploy"]
