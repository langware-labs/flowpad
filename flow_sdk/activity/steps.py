"""Named steps run as children of an activity — progress kept OUT of the work it reports on.

A job that is a fixed sequence (publish, plan, check, place) declares its steps as plain coroutines
and knows nothing of :class:`Activity`; this runner is the one place that turns "step N started /
ended / failed" into the activity tree a screen follows. Announce the whole sequence once
(:func:`announce`), then run it — in one go, or a prefix now and the rest after the caller has
answered (:attr:`Step.background`)::

    root = Activity.get("deploy", subject_entity=agent_typeid)
    announce(root, steps)
    await run_steps(root, [s for s in steps if not s.background])
    # ... answer the request, then, detached:
    await run_steps(root, [s for s in steps if s.background])
    root.done()
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass

from flow_sdk.activity.activity import Activity


@dataclass(frozen=True)
class Step:
    """One step of a sequence: its child name on the activity, how a screen reads it, and the work.

    ``background`` marks the slow tail a caller may run after answering — never a step that has to
    happen before the answer can be given.
    """

    name: str
    label: str
    run: Callable[[], Awaitable[object]]
    background: bool = False


def announce(root: Activity, steps: Iterable[Step]) -> Activity:
    """Put every step on *root* as pending, in order, before any starts: the outline is on the wire at once."""
    return root.plan([{"name": step.name, "label": step.label} for step in steps])


async def run_steps(root: Activity, steps: Iterable[Step]) -> None:
    """Run *steps* in order as children of *root*: each starts, then ends done — or failed with its error,
    which is raised. Ending *root* is the caller's: only it knows whether more steps follow."""
    for step in steps:
        node = root.child(step.name).label(step.label)
        try:
            await step.run()
        except BaseException as exc:
            node.fail(str(exc) or type(exc).__name__)
            raise
        node.done()


__all__ = ["Step", "announce", "run_steps"]
