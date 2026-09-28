"""``setup_wizards`` — the wizards a connection comes with, and the order they are completed in.

A driver (``data_driver.json``) or a credential (``credential.json``) declares them; a thing it
sets up — a data source, a credential's values — is not ready until each stage's wizard, run FOR
that thing (``Wizard.run(target=…)``), answers OK. A WhatsApp channel has a ``test`` stage (the
Meta test number, minutes) and a ``production`` stage (a real number, days of Meta review).

The wizards live beside the declaration, as child assets of the declaring folder
(``<asset>/agentic-assets/wizard/<name>/``), so a driver stays self-contained. Whether a stage is
done is never stored here or on the target: it is read off that wizard's run for the target, the
one record a run writes.
"""
from __future__ import annotations

from typing import ClassVar

from pydantic import ConfigDict

from flow_sdk.schema.data_spec._types import NonBlank
from flow_sdk.schema.data_spec.spec import DataSpec

#: What a stage is, for one target. ``pending``: not run, or its last run did not reach OK;
#: ``done``: its last run answered OK; ``locked``: an earlier stage is not done yet.
STAGE_PENDING = "pending"
STAGE_DONE = "done"
STAGE_LOCKED = "locked"


class SetupStageSpec(DataSpec):
    """One stage: a name the UI shows, and the wizard that completes it."""

    spec_kind: ClassVar[str] = "setup.stage"
    model_config = ConfigDict(frozen=True)

    #: A short id (``test``, ``production``) — unique within the declaration.
    stage: NonBlank
    label: str = ""
    #: The wizard's name.
    wizard: NonBlank

    @property
    def display_label(self) -> str:
        return self.label or self.stage.capitalize()


class SetupStageStateSpec(DataSpec):
    """One declared stage as it stands for one target — what a row carries for the UI."""

    spec_kind: ClassVar[str] = "setup.stage_state"
    model_config = ConfigDict(frozen=True)

    stage: str
    label: str
    wizard: str
    #: ``pending`` / ``done`` / ``locked``.
    state: str = STAGE_PENDING
    #: The last run's sentence, when there was one.
    detail: str = ""


def unique_stages(stages: list[SetupStageSpec]) -> list[SetupStageSpec]:
    """The validator body both declaring specs share: stage ids are unique."""
    seen: set[str] = set()
    for stage in stages:
        if stage.stage in seen:
            raise ValueError(f"setup_wizards: stage {stage.stage!r} is declared twice")
        seen.add(stage.stage)
    return stages


__all__ = [
    "STAGE_DONE", "STAGE_LOCKED", "STAGE_PENDING", "SetupStageSpec", "SetupStageStateSpec", "unique_stages",
]
