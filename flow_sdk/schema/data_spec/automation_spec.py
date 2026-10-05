"""The Automations screen's shapes (docs/automations.md).

Every value the Automations actions on ``Trigger`` return is one of these — the
screen, the CLI and an agent read the same fields. A ``Trigger`` row is the
entity; these are its person-facing readings.
"""

from __future__ import annotations

from typing import Any, ClassVar, Literal, Optional

from pydantic import ConfigDict, Field

from flow_sdk.schema.data_spec.spec import DataSpec

#: Plain-word kinds — what the screen says instead of hook / fsop / tag.
AutomationKind = Literal["schedule", "event", "file", "agent_hook"]
#: Where a rule sits in the list: this project, mine (everywhere), or Flowpad's own.
AutomationGroup = Literal["project", "mine", "builtin"]
#: One run's state. ``launched`` = an agent was started and its end is not known yet.
RunStatus = Literal["running", "launched", "succeeded", "failed", "skipped"]


class RunOnceStarted(DataSpec):
    """What *Run once now* answers: the run began (or finished, for a quick rule).

    ``event_id`` is the ``trigger.fired`` envelope the run's history row carries,
    so the screen can follow it into Runs."""

    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "automation.run_once"

    trigger_id: str
    event_id: Optional[str] = None
    #: True when the work continues in the background (most rules).
    background: bool = True
    error: Optional[str] = None
    detail: dict[str, Any] = Field(default_factory=dict)
