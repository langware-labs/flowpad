"""Fix: the last step of the one way an app comes up — validate → load → setup → fix.

A load whose setup ran and still failed gets the setup-fixer, launched HERE, once per failure, whoever
asked for the load (a screen, ``flow app open``, an agent's auto-open). Its verdict rides the load's own
answer (``LoadResult.fix``): a screen and the CLI read the same thing. A fix that worked loads again.
"""
from __future__ import annotations

import asyncio
import json
import logging
import tempfile
from pathlib import Path
from typing import Any, Optional

from flow_sdk.schema.data_spec.asset_setup_spec import LoadResult, SetupFix

logger = logging.getLogger(__name__)

#: The agent that repairs a setup flow (``agentic-assets/agent/setup-fixer``), driven by its skill.
FIXER_AGENT = "setup-fixer"
#: The receipt key the fixer's verdict is returned under.
VERDICT_KEY = "verdict"
VERDICT_SHAPE = {
    "outcome": "<fixed|not_fixed>",
    "summary": "<one line: what was wrong and what you did>",
    "user_action": "<when not_fixed: what the person must do, in plain words; else null>",
}

#: Each ``(project, asset)``'s fix: the running one, or the last verdict.
_FIXES: dict[tuple[str, str], SetupFix] = {}
_TASKS: dict[tuple[str, str], asyncio.Task] = {}


def fix_of(pid: str, asset: str = "") -> Optional[SetupFix]:
    return _FIXES.get((pid, asset))


def forget(pid: str, asset: str = "") -> None:
    """A load that came up READY needs no fix, and its last verdict is history."""
    if (pid, asset) not in _TASKS:
        _FIXES.pop((pid, asset), None)


def start_fix(pid: str, failed: LoadResult, *, again: bool = False) -> SetupFix:
    """Launch the fixer on ``failed`` — or answer the one already running for it. Never raises.

    Unasked, once: a failure after a verdict keeps that verdict (a "fixed" that did not hold says so)
    until the load comes up. ``again`` is the person pressing Fix it."""
    key = (str(pid), failed.asset or "")
    running = _TASKS.get(key)
    if running is not None and not running.done():
        return _FIXES[key]
    last = _FIXES.get(key)
    if last is not None and not again:
        if last.state == "fixed":
            _FIXES[key] = last.model_copy(update={
                "state": "not_fixed",
                "user_action": "The fixer's repair did not hold. Open its process to see what it changed.",
            })
        return _FIXES[key]
    _FIXES[key] = SetupFix(state="running")
    task = asyncio.ensure_future(_run(failed, key))
    _TASKS[key] = task
    task.add_done_callback(lambda done: _TASKS.pop(key, None) if _TASKS.get(key) is done else None)
    return _FIXES[key]


async def stop_fix(pid: str, asset: str = "") -> bool:
    """Stop the fix running here. ``False`` when none was."""
    key = (pid, asset)
    task = _TASKS.get(key)
    if task is None or task.done():
        return False
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    _FIXES.pop(key, None)
    return True


def _prompt(failed: LoadResult) -> str:
    payload = {
        "error": failed.detail,
        "project_id": failed.project_id,
        "asset": failed.asset,
        "tree": failed.tree.model_dump(mode="json") if failed.tree is not None else None,
    }
    return f"Use the setup-fixer skill to fix this failed setup.\n\nInput:\n{json.dumps(payload, indent=2)}"


async def _run(failed: LoadResult, key: tuple[str, str]) -> None:
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.core.compute.process_step import launch_step_process  # noqa: PLC0415
    from flow_sdk.core.compute.receipt import read_step_result, result_contract  # noqa: PLC0415

    def seen(progress: Any) -> None:
        if progress.executor and _FIXES.get(key) is not None:
            _FIXES[key] = _FIXES[key].model_copy(update={"process": progress.executor})

    try:
        project = await Project.get_by_id(key[0])
        if project is None:
            raise LookupError(f"there is no project {key[0]} here")
        with tempfile.TemporaryDirectory(prefix="setup-fix-") as tmp:
            path = Path(tmp) / "result.json"
            said = await launch_step_process(
                agent=FIXER_AGENT,
                prompt=_prompt(failed) + result_contract(path, VERDICT_KEY, VERDICT_SHAPE),
                name="Fix the setup",
                workdir=Path(getattr(project, "fs_storage_mount_path", None) or tmp),
                target_typeid_str=f"project-{key[0]}",
                on_status=seen,
            )
            receipt = read_step_result(path, output=VERDICT_KEY) if said.ok else None
        verdict = receipt.value if receipt is not None and receipt.ok and isinstance(receipt.value, dict) else {}
        fixed = verdict.get("outcome") == "fixed"
        _FIXES[key] = _FIXES[key].model_copy(update={
            "state": "fixed" if fixed else "not_fixed",
            "process": _FIXES[key].process or said.executor,
            "summary": str(verdict.get("summary") or (receipt.error if receipt else said.detail) or ""),
            "user_action": "" if fixed else str(verdict.get("user_action") or
                                                "The fixer could not repair this setup. Open its process to see what it found."),
        })
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 — a fixer that broke is a verdict, never a crash
        logger.warning("setup fix of %s failed: %s", key, exc, exc_info=True)
        _FIXES[key] = SetupFix(state="not_fixed", summary=str(exc), user_action="The fixer could not start.")
        return
    if _FIXES[key].state == "fixed":
        # What the fix earns: setup again, from the declaration the fixer left on disk — a fresh run,
        # not the spent repair of the failure it fixed.
        from flow_sdk.core.setup import load  # noqa: PLC0415

        load._REPAIRED.discard(key)
        load.forget(key[0], key[1])
        await load.load_project(project, approved=True, asset=await _asset(key[1]))


async def _asset(typeid: str) -> Any:
    if not typeid:
        return None
    from flow_sdk.core import Entity  # noqa: PLC0415

    try:
        return await Entity.get_by_typeid(typeid)
    except ValueError:  # an unregistered type
        return None


__all__ = ["FIXER_AGENT", "fix_of", "forget", "start_fix", "stop_fix"]
