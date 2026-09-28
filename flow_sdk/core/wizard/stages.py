"""Where a thing's setup stands: each declared stage, read off its wizard's run for that thing.

Nothing is stored for this. A stage is ``done`` when its wizard's last run FOR the target answered
OK (``state.run_key``), ``locked`` while an earlier stage is not done, else ``pending`` — so the
record a run writes is the only record, and re-running a wizard (resume) is the only way to move it.
Shared by every declaring type (a data source through its driver, a credential through itself).
"""
from __future__ import annotations

from typing import Iterable

from flow_sdk.core.wizard.state import read_result, run_key
from flow_sdk.schema.data_spec.setup_stage_spec import (
    STAGE_DONE,
    STAGE_LOCKED,
    STAGE_PENDING,
    SetupStageSpec,
    SetupStageStateSpec,
)


async def stage_states(stages: Iterable[SetupStageSpec], target: str) -> list[SetupStageStateSpec]:
    """Each of ``stages`` as it stands for ``target``, in declaration order."""
    from flow_sdk.builtin.wizard import Wizard  # noqa: PLC0415 — entity layer, kept off import

    out: list[SetupStageStateSpec] = []
    earlier_done = True
    for stage in stages:
        wizard = await Wizard.get_one({"name": stage.wizard})
        result = read_result(run_key(str(wizard.id), target)) if wizard is not None else None
        if result is not None and result.ok:
            state = STAGE_DONE
        else:
            state = STAGE_PENDING if earlier_done else STAGE_LOCKED
        detail = result.detail if result is not None else ("" if wizard is not None else f"no wizard named {stage.wizard!r}")
        out.append(SetupStageStateSpec(
            stage=stage.stage, label=stage.display_label, wizard=stage.wizard, state=state, detail=detail,
        ))
        earlier_done = earlier_done and state == STAGE_DONE
    return out
