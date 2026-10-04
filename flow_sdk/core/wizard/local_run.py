"""Run a SHIPPED wizard or compute op in this process — the CLI's path when no backend is up.

``flow wizard run`` / ``flow op run`` call a backend when one is running. A box with only the wheel
has none, and the runners never needed one: ``run_wizard`` and ``run_op`` are pure. What the
backend adds is the index (``Wizard.by_name`` reads rows), so here the callees are read straight
off the shipped asset folders, and only those: a shipped asset is trusted where it ships.

Questions: a run here is answered here. ``yes=True`` is the person who typed ``--yes`` answering
every CONFIRM question in advance; any other question (a secret, a file, a value) needs a person,
so it is cancelled with a sentence saying so rather than waiting for a tab that does not exist.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

from flow_sdk.schema.data_spec.returned_value_spec import (
    AskResult,
    CliResult,
    PromptResult,
    ReturnedValue,
    WizardResult,
)


def shipped_assets() -> Path:
    from flow_sdk.config import flowpad_assistant_project_root  # noqa: PLC0415

    return flowpad_assistant_project_root() / "agentic-assets"


def read_op(name: str) -> Any:
    """The shipped op named *name* (with its ``setup.md``), or None."""
    from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec  # noqa: PLC0415

    folder = shipped_assets() / "compute_op" / name
    if not (folder / "compute_op.json").is_file():
        return None
    body = json.loads((folder / "compute_op.json").read_text(encoding="utf-8"))
    setup = folder / "setup.md"
    if setup.is_file():
        body["setup"] = setup.read_text(encoding="utf-8")
    return ComputeOpSpec.model_validate(body)


async def resolve_op(name: str) -> Any:
    from flow_sdk.core.wizard.runner import Resolved  # noqa: PLC0415

    spec = read_op(name)
    return Resolved(spec, True) if spec is not None else None


async def resolve_wizard(name: str) -> Any:
    from flow_sdk.assets.types.wizard import read_wizard  # noqa: PLC0415
    from flow_sdk.core.wizard.runner import Resolved  # noqa: PLC0415

    spec = read_wizard(shipped_assets() / "wizard" / name)
    return Resolved(spec, True) if spec is not None else None


def satisfied_by(answer: ReturnedValue) -> str:
    """Which call settled an op's answer: ``already`` (the goal held; nothing ran), ``nothing``
    (nothing ran and the goal does not hold — a check, a refusal), else the
    subkind whose answer it is — ``cli`` for the command, ``agent`` / ``prompt`` for a model, ``ask``
    for a person. A rung's answer is that rung's own class (``run_op`` returns the rescuing rung's
    answer), so the class says which rung it was without parsing a sentence."""
    if not answer.ran:
        # Nothing ran: either the goal already held, or nothing was attempted (a check, a refusal).
        return "already" if answer.ok else "nothing"
    if isinstance(answer, CliResult):
        return "cli"
    if isinstance(answer, PromptResult):
        return "agent" if str(answer.executor or "").startswith("agentic_process") else "prompt"
    if isinstance(answer, AskResult):
        return "ask"
    if isinstance(answer, WizardResult):
        return "wizard"
    return "unknown"


def step_rows(result: ReturnedValue, prefix: str = "") -> list[dict]:
    """Every step of *result*, nested wizards flattened (``outer/inner``), with who settled it."""
    rows: list[dict] = []
    for step_id, step in (getattr(result, "steps", None) or {}).items():
        path = f"{prefix}{step_id}"
        rows.append(
            {
                "step": path,
                "exit_code": int(step.exit_code),
                "ok": step.ok,
                "by": satisfied_by(step),
                "detail": step.detail,
            }
        )
        rows.extend(step_rows(step, prefix=f"{path}/"))
    return rows


async def _answer_questions(stop: asyncio.Event, *, yes: bool, say: Callable[[str], None]) -> None:
    from flow_sdk.core.compute_op import ask  # noqa: PLC0415

    while not stop.is_set():
        for question in ask.open_questions():
            if yes and question.shape == "confirm":
                say(f"? {question.prompt} — yes (--yes)")
                ask.answer(question.id, {})
            else:
                why = "pass --yes to accept it" if question.shape == "confirm" else "it needs a person (--yes answers confirm questions only)"
                say(f"? {question.prompt} — not answered: {why}")
                ask.cancel(question.id)
        await asyncio.sleep(0.05)


async def _answered(run: Awaitable[Any], *, yes: bool, say: Callable[[str], None]) -> Any:
    """Await *run* with this process answering its questions."""
    from flow_sdk.core.compute_op import ask  # noqa: PLC0415

    stop = asyncio.Event()
    answerer = asyncio.create_task(_answer_questions(stop, yes=yes, say=say))
    try:
        with ask.answered_here(present=True):
            return await run
    finally:
        stop.set()
        answerer.cancel()


def _workdir(name: str) -> Path:
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    workdir = get_instance_settings().instance_dir / "wizard-runs" / name
    workdir.mkdir(parents=True, exist_ok=True)
    return workdir


async def run_shipped_wizard(
    name: str,
    *,
    yes: bool = False,
    say: Callable[[str], None] = lambda _text: None,
) -> Optional[WizardResult]:
    """Run the shipped wizard *name* here; ``None`` when no wizard by that name ships."""
    from flow_sdk.core.wizard.runner import run_wizard  # noqa: PLC0415

    found = await resolve_wizard(name)
    if found is None:
        return None

    async def on_step(partial: WizardResult) -> None:
        if not partial.steps:
            return
        step_id, step = list(partial.steps.items())[-1]
        say(f"step {step_id}: {step.exit_code.name} by {satisfied_by(step)} — {step.detail}")

    return await _answered(
        run_wizard(
            found.spec,
            activity_path=f"wizard/{name}",
            trusted=True,
            workdir=_workdir(name),
            resolve_op=resolve_op,
            resolve_wizard=resolve_wizard,
            on_step=on_step,
        ),
        yes=yes,
        say=say,
    )


async def run_shipped_op(
    name: str,
    *,
    yes: bool = False,
    check_only: bool = False,
    say: Callable[[str], None] = lambda _text: None,
) -> Optional[ReturnedValue]:
    """Run (or only check) the shipped op *name* here; ``None`` when no op by that name ships."""
    from flow_sdk.core.compute_op import run_op  # noqa: PLC0415

    spec = read_op(name)
    if spec is None:
        return None
    return await _answered(
        run_op(spec, trusted=True, workdir=_workdir(name), on_status=say, check_only=check_only),
        yes=yes,
        say=say,
    )
