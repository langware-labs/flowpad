"""Agent ``auto_open`` — what a new session as an agent opens with.

An entry is a place, a ``navigate`` op or a wizard (``auto_open_spec``). Every place
is shown AT ONCE (below); ops and wizards then run behind the landing
(``start_auto_open``), where a navigate op's ``attempts`` repair what it found — a
server that is down — and it opens again, which reloads the display. Each entry's
answer is kept on the session (``context_data.auto_open_results``).

``agent.json`` declares places as ``DockPointerSpec`` values (``Tab.pointer`` JSON);
a file is named relative to the agent's project (``vfs/project-<id>/<rel>``) so
the declaration travels with the repo. Opening a session rebases each one onto
this machine and writes the tabs on the backend — the single tab writer — so
every opener (Use, the project home page, auto-launch) gets the same tabs and
the frontend only renders them:

* the FIRST entry is the session's active display (``on_show`` → ``last_shown``,
  which the Vibe landing restores);
* the rest are workspace tabs under the session's own tab (``parent_tab_id``).
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from flow_sdk.api.api_types.vfs_path import VFSPath
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.schema.data_spec.dock_pointer_spec import PROJECT_VFS, DockPointerSpec, tab_pointer_json
from flow_sdk.schema.types import EntityType

if TYPE_CHECKING:
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.builtin.compute_op import ComputeOp
    from flow_sdk.builtin.project import Project
    from flow_sdk.builtin.wizard import Wizard
    from flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue

logger = logging.getLogger(__name__)

#: The named id the frontend's file pointers use (``LOCAL_COMPUTE_NODE`` in
#: ``ui/src/.../asset-doc-types.ts``): a rebased pointer must match the tab the UI
#: would write for the same file byte for byte, or the two are different tabs.
LOCAL_COMPUTE_NODE = TypeId(type=EntityType.COMPUTE_NODE.value, id="@local")


@dataclass(frozen=True)
class AutoOpenTab:
    """One declared tab, rebased onto this machine."""

    #: ``Tab.pointer`` JSON as the frontend writes it for this file on this machine.
    pointer: str
    #: The file it shows; ``None`` for a screen (a pointer with no project file).
    path: Optional[Path] = None


def project_ids(entries: list[DockPointerSpec] | None) -> set[str]:
    """The literal project ids the declared files are rooted in."""
    return {found["project"] for spec in entries or [] if (found := PROJECT_VFS.search(spec.pointer))}


def rebase_auto_open(entries: list[DockPointerSpec] | None, *, roots: dict[str, str]) -> list[AutoOpenTab]:
    """Rebase declared tabs onto this machine; drop (and say why) what cannot open here.

    A ``vfs/project-<id>/<rel>`` segment becomes ``vfs/compute_node-@local/<abs>`` —
    the form the editor renders. ``roots`` maps the agent's OWN projects to their
    folders: the declaration names a literal project id, which only resolves where
    the project kept the id it was shared with — any other id is dropped, loudly.
    """
    tabs: list[AutoOpenTab] = []
    for spec in entries or []:
        found = PROJECT_VFS.search(spec.pointer)
        if found is None:
            tabs.append(AutoOpenTab(pointer=spec.to_json()))
            continue
        if found["project"] not in roots:
            logger.warning("auto_open %s names project %s, which this agent does not live in (%s) — dropped",
                           spec.pointer, found["project"], sorted(roots) or "none")
            continue
        base = Path(roots[found["project"]]).resolve()
        path = (base / found["rel"]).resolve()
        if not path.is_relative_to(base) or not path.is_file():
            logger.warning("auto_open %s: no file %s in the project — dropped", spec.pointer, path)
            continue
        local = VFSPath.from_machine_path(str(path), LOCAL_COMPUTE_NODE)
        pointer = f"{spec.pointer[:found.start()]}{found.group(1)}vfs/{local.abs_path}"
        # Plain JSON, not a DockPointerSpec: the rebased pointer names THIS machine,
        # which is exactly what a declared (travelling) pointer is refused for.
        tabs.append(AutoOpenTab(pointer=tab_pointer_json(spec.viewType, pointer), path=path))
    return tabs


async def open_auto_tabs(process: "AgenticProcess", tabs: list[AutoOpenTab]) -> None:
    """Open ``tabs`` for a fresh session: the first as its active display, the rest
    as workspace tabs under the session's own tab."""
    if not tabs:
        return
    from flow_sdk.builtin.tab import broadcast_tabs_changed, ensure_tab  # noqa: PLC0415
    from flow_sdk.core.display_target import dock_target, resolve_display_target  # noqa: PLC0415

    # The session's own tab FIRST: a child whose parent row does not exist yet is
    # orphaned by the next tab-list read (the dangling-parent sweep).
    anchor = await ensure_tab(
        tab_pointer_json("shell", f"{process.get_type()}-{process.id}"),
        target_type=process.get_type(),
        target_id=str(process.id),
        project_id=process.project_id,
    )
    for tab in tabs[1:]:
        # Named on create: a nameless row falls back to the view's generic label.
        name = tab.path.name if tab.path is not None else None
        await ensure_tab(tab.pointer, project_id=process.project_id, parent_tab_id=anchor.id, name=name)
    first = tabs[0]
    if first.path is not None:
        target = await resolve_display_target(path=str(first.path))
    else:
        address = json.loads(first.pointer)
        target = await dock_target(f"{address['viewType']}/{address['pointer']}")
    await process.on_show(target)
    await broadcast_tabs_changed()


# ── ops and wizards: shown at once, repaired in the background ────────────────


@dataclass(frozen=True)
class AutoOpenRun:
    """One entry's background work, reported under ``entry``."""

    entry: str
    op: Optional["ComputeOp"] = None
    wizard: Optional["Wizard"] = None
    #: A plain place: already shown, probed once so its state is on record.
    place: Optional[DockPointerSpec] = None


@dataclass
class AutoOpenPlan:
    """What a session opens with: the places to show NOW (first = active display),
    the background runs, and the entries that name nothing here (already answers)."""

    places: list[DockPointerSpec] = field(default_factory=list)
    runs: list[AutoOpenRun] = field(default_factory=list)
    missing: list[dict] = field(default_factory=list)


def _record(entry: str, answer: "ReturnedValue") -> dict:
    """One entry's answer as ``context_data.auto_open_results`` keeps it."""
    return {
        "entry": entry,
        "exit_code": int(answer.exit_code),
        "verdict": getattr(answer, "verdict", None),
        "detail": answer.detail,
    }


async def find_in_roots(cls: type, type_name: str, name: str, roots: list[str], project: Optional["Project"]):
    """The ``cls`` asset named ``name`` in ``roots`` — the agent's own project and its
    direct context folders, the boundary ``auto_launch`` keeps. On a first open its row
    may not exist yet (the project's first index runs detached), so it is indexed then."""
    from flow_sdk.builtin.project import assets_under_roots  # noqa: PLC0415

    async def lookup():
        hits = assets_under_roots(await cls.get_all({"match": {"name": name}}), roots)
        return hits[0] if hits else None

    found = await lookup()
    if found is None and project is not None:
        await project.index_missing_assets(f"auto_open:{type_name}:{name}", {type_name}, lambda c: c.path.name == name)
        found = await lookup()
    return found


async def plan_auto_open(entries: list, *, roots: list[str], project: Optional["Project"]) -> AutoOpenPlan:
    """Resolve ``auto_open`` entries: what to show now, what to run, what is missing."""
    from flow_sdk.builtin.compute_op import ComputeOp  # noqa: PLC0415
    from flow_sdk.builtin.wizard import Wizard  # noqa: PLC0415
    from flow_sdk.schema.data_spec.auto_open_spec import AutoOpenOp, AutoOpenWizard  # noqa: PLC0415
    from flow_sdk.schema.data_spec.compute_op_spec import NavigateOp  # noqa: PLC0415
    from flow_sdk.schema.data_spec.returned_value_spec import NavigateResult  # noqa: PLC0415

    plan = AutoOpenPlan()
    for entry in entries or []:
        if isinstance(entry, DockPointerSpec):
            plan.places.append(entry)
            plan.runs.append(AutoOpenRun(entry=entry.to_json(), place=entry))
        elif isinstance(entry, AutoOpenOp):
            op = await find_in_roots(ComputeOp, "compute_op", entry.op, roots, project)
            spec = op.spec() if op is not None else None
            if spec is None:
                plan.missing.append(_record(f"op:{entry.op}", NavigateResult.not_found(
                    f"No compute op {entry.op!r} in this agent's project.", verdict="not_found")))
                continue
            if isinstance(spec.exe_data, NavigateOp) and spec.exe_data.target is not None:
                plan.places.append(spec.exe_data.target)
            plan.runs.append(AutoOpenRun(entry=f"op:{entry.op}", op=op))
        elif isinstance(entry, AutoOpenWizard):
            wizard = await find_in_roots(Wizard, "wizard", entry.wizard, roots, project)
            if wizard is None:
                plan.missing.append(_record(f"wizard:{entry.wizard}", NavigateResult.not_found(
                    f"No wizard {entry.wizard!r} in this agent's project.", verdict="not_found")))
                continue
            plan.runs.append(AutoOpenRun(entry=f"wizard:{entry.wizard}", wizard=wizard))
    return plan


async def run_auto_open(process: "AgenticProcess", plan: AutoOpenPlan) -> list[dict]:
    """Run every entry's background work for *process*, in order, and keep the answers
    on the session (``context_data.auto_open_results``). A ``navigate`` op shows its
    place again when a repair made it usable — that is what reloads the display.

    Approved by declaration: the op or wizard lives in the agent's own project (see
    ``find_in_roots``) — the same trust ``auto_launch`` gives that project's agent and
    its auto prompt. Never raises: an entry that breaks is an answer, not a crash.
    """
    from flow_sdk.builtin.tab import broadcast_tabs_changed  # noqa: PLC0415
    from flow_sdk.core.navigate import navigate  # noqa: PLC0415
    from flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue  # noqa: PLC0415

    subject = f"{process.get_type()}-{process.id}"
    results = list(plan.missing)
    for run in plan.runs:
        try:
            if run.op is not None:
                answer = await run.op.run(subject=subject, approved=True)
            elif run.wizard is not None:
                answer = await run.wizard.run(approved=True, unattended=True, target=subject)
            else:
                answer = await navigate(run.place, process=process, show=False)
        except Exception as exc:  # noqa: BLE001 -- one entry cannot stop the others
            logger.warning("auto_open %s failed", run.entry, exc_info=True)
            answer = ReturnedValue.not_yet(f"{run.entry}: {exc}")
        results.append(_record(run.entry, answer))
        logger.info("auto_open %s → %s %s", run.entry, answer.exit_code.name, answer.detail)
    await _keep_results(process, results)
    await broadcast_tabs_changed()
    return results


async def _keep_results(process: "AgenticProcess", results: list[dict]) -> None:
    """Write the answers on the freshest row — a normal save, which keeps the display
    keys as ``on_show`` left them (``_preserve_latest_display_pin``)."""
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess  # noqa: PLC0415

    fresh = await AgenticProcess.get_by_id(process.id) or process
    fresh.context_data = {**(fresh.context_data or {}), "auto_open_results": results}
    await fresh.save()


def start_auto_open(process: "AgenticProcess", plan: AutoOpenPlan) -> "Optional[asyncio.Task]":
    """``run_auto_open`` detached from the request that opened the session: the person
    lands at once, and a repair that takes minutes runs behind them."""
    if not plan.runs and not plan.missing:
        return None
    from flow_sdk.request_context.detached import create_detached_task  # noqa: PLC0415

    return create_detached_task(run_auto_open(process, plan), name=f"auto_open:{process.id}")
