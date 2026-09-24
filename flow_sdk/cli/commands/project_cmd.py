"""``flow project ...`` — the working directory's project.

    flow project setup              — walk through every connection and credential it needs
    flow project setup --dry-run    — only list them, and which already hold
    flow project setup --no-ai      — never hand a value to the AI setup

``setup`` collects what the project needs (``builtin/project_setup``), compiles it into a wizard
held in memory, and runs it HERE with the stock runner: each question is asked on this terminal
(a secret masked), each value is stored through ``flow credentials set``, and each credential that
carries ``setup`` instructions gets an AI rung — the ``provisioner`` agent — for whatever was left
empty. Running it again is the resume: whatever holds is skipped.

Exit codes are ``ExitCode``'s: 0 when everything the project needs holds; 1 when something does
not yet (the output says what); 2 when there is no project here.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Optional

import typer
from typing_extensions import Annotated

from flow_sdk.cli.commands._common import EXIT_INVALID_ARG, fail
from flow_sdk.schema.data_spec.project_setup_spec import REQUIREMENT_GAP, REQUIREMENT_OAUTH
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode

if TYPE_CHECKING:
    from flow_sdk.schema.data_spec.project_setup_spec import SetupRequirementSpec

project_app = typer.Typer(
    name="project",
    help="The working directory's project.",
    add_completion=False,
    no_args_is_help=True,
)

EXIT_NOT_YET = int(ExitCode.NOT_YET)

#: Seams a test replaces: how a step's shell command runs, and how an agent op is launched.
#: ``None`` is the runner's own default.
_shell: Optional[Callable[..., Any]] = None
_launch: Optional[Callable[..., Any]] = None


def _read(prompt: str, secret: bool) -> str:
    """One answer from the person at this terminal. A secret is never echoed; a closed stdin is empty.
    The question goes to stderr, so ``--json`` output stays one line."""
    typer.echo("", err=True)
    if secret and sys.stdin.isatty():
        import getpass  # noqa: PLC0415

        try:
            return getpass.getpass(prompt + "\n> ")
        except EOFError:
            return ""
    typer.echo(prompt + "\n> ", nl=False, err=True)
    return (sys.stdin.readline() or "").rstrip("\r\n")


async def _answer_questions(stop: asyncio.Event) -> None:
    """The terminal side of every ``ask`` step: take each open question, one at a time, and answer it.

    A late answer (the op already gave up) is refused by ``ask.answer`` — the step reported its own
    timeout, and the next run asks again.
    """
    from flow_sdk.core.compute_op import ask  # noqa: PLC0415

    seen: set[str] = set()
    while not stop.is_set():
        for question in ask.open_questions():
            if question.id in seen:
                continue
            seen.add(question.id)
            value = await asyncio.to_thread(_read, question.prompt, question.secret)
            ask.answer(question.id, value.strip())
        await asyncio.sleep(0.05)


def _state(req: "SetupRequirementSpec") -> str:
    if req.kind == REQUIREMENT_GAP:
        return "cannot be set up here"
    if req.satisfied is None:
        return "checked when run"
    if req.satisfied:
        return "ready"
    names = ", ".join(v.env_var for v in req.missing)
    return f"missing {names}" if names else "missing"


def _describe(req: "SetupRequirementSpec") -> dict[str, Any]:
    return {
        "kind": req.kind, "name": req.name, "state": _state(req), "used_by": req.used_by,
        "missing": [v.env_var for v in req.missing], "ai_setup": bool(req.setup.strip()), "note": req.note,
    }


def _print_plan(requirements: list["SetupRequirementSpec"]) -> None:
    for req in requirements:
        label = "connection" if req.kind == REQUIREMENT_OAUTH else ("credential" if req.kind != REQUIREMENT_GAP else "gap")
        users = f"  (for {', '.join(req.used_by)})" if req.used_by else ""
        typer.echo(f"  {label:<10} {req.name:<24} {_state(req)}{users}")
        if req.note:
            typer.echo(f"             {req.note}")


def _step_line(label: str, answer: Any, *, asked: bool = False) -> str:
    """One step's outcome. An ask step's value never appears — only whether one was given."""
    if answer is None:
        return f"  ·  {label}: not reached"
    if asked and answer.ok:
        return f"  ✓  {label}: answered" if answer.value else f"  ·  {label}: left empty"
    if answer.ok and not answer.ran:
        return f"  ✓  {label}: already done"
    if answer.ok:
        return f"  ✓  {label}: done"
    return f"  ✗  {label}: {(answer.detail or 'failed').removeprefix(label + ': ')}"


def _requirement_done(req: "SetupRequirementSpec", steps: dict[str, Any]) -> bool:
    """Whether a requirement ended holding: its connect / store / AI step reached the goal."""
    if req.kind == REQUIREMENT_GAP:
        return False
    names = [f"connect-{req.name}"] if req.kind == REQUIREMENT_OAUTH else [f"store-{req.name}", f"ai-{req.name}"]
    return any(steps.get(n) is not None and steps[n].ok for n in names)


async def _run(project_id: Optional[str], *, dry_run: bool, ai: bool, as_json: bool) -> int:
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.builtin.project_setup import collect_requirements, compile_setup  # noqa: PLC0415
    from flow_sdk.core.compute_op import ask  # noqa: PLC0415
    from flow_sdk.core.wizard.runner import Resolved, run_wizard  # noqa: PLC0415

    project = await (Project.get_by_id(project_id) if project_id else Project.find_by_cwd(os.getcwd()))
    if project is None:
        fail(EXIT_INVALID_ARG, "NO_PROJECT", "no project here: cd into a project folder or pass --project")

    requirements = await collect_requirements(project)
    if not as_json:
        typer.echo(f"{project.name or project.id}: {len(requirements)} to set up")
        _print_plan(requirements)
    if dry_run:
        if as_json:
            typer.echo(json.dumps({"ok": True, "project_id": str(project.id),
                                                 "requirements": [_describe(r) for r in requirements]}))
        return int(ExitCode.OK)

    wizard, ops = compile_setup(str(project.id), requirements, ai=ai)
    steps: dict[str, Any] = {}
    if wizard.steps:

        async def resolve(name: str) -> Optional[Resolved]:
            return Resolved(ops[name], True) if name in ops else None

        # The questions are asked on this terminal, never in a browser window.
        no_browser = os.environ.get("FLOWPAD_NO_BROWSER")
        os.environ["FLOWPAD_NO_BROWSER"] = "1"
        stop = asyncio.Event()
        answerer = asyncio.create_task(_answer_questions(stop))
        seams = {k: v for k, v in (("shell", _shell), ("launch", _launch)) if v is not None}
        try:
            # This terminal is where the answers arrive — hold the questions here, never at a backend.
            with ask.answered_here():
                result = await run_wizard(
                    wizard, activity_path=f"project-setup/{project.id}", trusted=True,
                    workdir=Path(project.fs_storage_mount_path or os.getcwd()), resolve_op=resolve, **seams,
                )
        finally:
            stop.set()
            answerer.cancel()
            if no_browser is None:
                os.environ.pop("FLOWPAD_NO_BROWSER", None)
        steps = dict(result.steps or {})
        asks = {name for name, op in ops.items() if op.subkind == "ask"}
        if not as_json:
            typer.echo("")
            for step in wizard.steps:
                typer.echo(_step_line(step.display_label, steps.get(step.id), asked=step.id in asks))

    outcome = [{**_describe(r), "done": _requirement_done(r, steps)} for r in requirements]
    ready = all(o["done"] for o in outcome)
    if as_json:
        typer.echo(json.dumps({"ok": ready, "project_id": str(project.id), "requirements": outcome}))
    else:
        left = [o["name"] for o in outcome if not o["done"]]
        typer.echo("")
        typer.echo("Everything is set up." if ready else f"Not set up yet: {', '.join(left)}. Run it again to continue.")
    return int(ExitCode.OK if ready else ExitCode.NOT_YET)


@project_app.command("setup")
def setup_project(
    project: Annotated[Optional[str], typer.Option("--project", help="Project id (default: the working directory's).")] = None,
    dry_run: Annotated[bool, typer.Option("--dry-run", help="Only list what is needed, and what already holds.")] = False,
    no_ai: Annotated[bool, typer.Option("--no-ai", help="No AI setup: a value left empty stays missing.")] = False,
    as_json: Annotated[bool, typer.Option("--json", help="One JSON line; no values in it.")] = False,
) -> None:
    """Set up every connection and credential the project needs, one step at a time."""
    code = asyncio.run(_run(project, dry_run=dry_run, ai=not no_ai, as_json=as_json))
    if code:
        raise typer.Exit(code)
