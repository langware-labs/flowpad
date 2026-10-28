"""An agent's cloud deploy over HTTP (``POST agent/<id>/deploy``): the request, and the activity its steps run under.

``Agent.deploy_to_cloud`` is the deploy, as five plain steps — publish the agent, share its hub dependencies, plan
its placement on the hub, check readiness, have the hub place it on a machine — that know nothing of progress.
:func:`run_deployment_steps` runs them under the agent's ``deploy`` activity, each step one of its children. The
request is answered as soon as the activity is claimed and every step runs after it: the activity is what tells
the screen how it goes, a refusal (a missing value, a publish problem) included. A deploy that waits runs them all
before answering (``flow agent deploy``).

Model funding never refuses a deploy (``requirement_spec.ADVISORY_KINDS``): a placement with nothing to spend is
placed all the same, and the answer of a deploy that waits carries the warning.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, ClassVar, Optional

from pydantic import ConfigDict, field_validator

from flow_sdk.schema.data_spec.credential_contract import is_valid_environment
from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.schema.data_spec.token_allocation_spec import TokenAllocationSpec

if TYPE_CHECKING:
    from flow_sdk.builtin.agent import Agent

logger = logging.getLogger(__name__)

#: The activity a deploy reports on, under its agent.
DEPLOY_ACTIVITY = "deploy"


class AgentDeployRequest(DataSpec):
    """Where to deploy an agent and how. ``provider``: ``local`` is this computer, any other the hub's name for a
    compute provider, empty the hub's default. ``environment``: the credential environment a cloud placement
    reads (empty: ``production``). ``token_allocation``: the placement's own budget — absent leaves it as it is,
    ``null`` releases it. ``wait``: answer only once the machine is placed."""

    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "agent.deploy_request"

    provider: str = ""
    environment: Optional[str] = None
    token_allocation: Optional[TokenAllocationSpec] = None
    wait: bool = False

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


@dataclass(frozen=True)
class DeployStep:
    """One step of the deploy: its child's name on the activity, how a screen reads it, and the work."""

    name: str
    label: str
    run: Callable[[], Awaitable[None]]


async def run_deployment_steps(agent: "Agent", steps: list[DeployStep], *, background: bool) -> dict[str, str]:
    """*steps* under *agent*'s ``deploy`` activity, each as its child — running, then done or failed with its
    error — then the activity's end. They run after this returns when *background*, a failure told only on the
    activity; before it otherwise, a failing step raised here.

    The answer: where the activity reports. Single-flight per agent: a deploy already running raises
    :class:`DeployRunning`.
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
    root.label(f"Deploy {agent.name or agent.id}").plan([{"name": step.name, "label": step.label} for step in steps])

    async def run() -> None:
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
            if not background:
                raise
            logger.warning("cloud deploy of %s failed: %s", subject, exc)
            return
        root.done()

    if background:
        create_detached_task(run(), name=f"agent-deploy:{agent.id}")
    else:
        await run()
    return {"path": DEPLOY_ACTIVITY, "subject_entity": subject}


__all__ = ["DEPLOY_ACTIVITY", "AgentDeployRequest", "DeployRunning", "DeployStep", "run_deployment_steps"]
