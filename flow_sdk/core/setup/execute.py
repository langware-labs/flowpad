"""Run ONE setup of a root: its slot, its record, the run its questions name.

``setup_tree`` is entity-free; this is the layer every caller with a real root goes through — the
project's Set up, a source's, a received artifact's — so the four things they all need are written once:

* **One run per root.** A non-blocking FileLock on the run directory (``run_key(SETUP_RUN, root)``), the
  same discipline ``execute_wizard`` keeps: a second start answers ``held`` at once, never queues.
* **A record that keeps up.** The tree is stamped into the run file after every step (``record_tree``),
  so a screen that missed a push — or opens mid-run — reads the whole picture from ``read_setup``.
* **Questions that name the run.** ``ASKING_RUN`` is the setup's activity address, so one screen claims
  every question the tree asks, however deep the node that asked it.
* **A check takes no slot.** Readiness runs the same walk in check mode and records nothing.
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from flow_sdk.core.setup.tree import NodeResolver
from flow_sdk.core.setup.walk import OnChange, setup_tree
from flow_sdk.core.wizard.state import read_tree, record_tree, run_dir, run_key, target_segment
from flow_sdk.schema.data_spec.asset_setup_spec import SetupState, SetupTreeResult

#: The kind of run, standing in for a wizard id in ``run_key``: setups live beside wizard runs.
SETUP_RUN = "asset-setup"


def setup_activity_path(root_id: str) -> str:
    """The setup's activity ROOT — also the address its questions carry. One per root."""
    return f"setup-{target_segment(root_id)}"


def read_setup(root_id: str) -> Optional[SetupTreeResult]:
    """The last (or current) setup of ``root_id`` as recorded, or ``None``."""
    return read_tree(run_key(SETUP_RUN, root_id))


async def execute_setup(
    root_id: str,
    *,
    resolve_node: NodeResolver,
    resolve_op=None,
    resolve_wizard=None,
    subject_entity: Optional[str] = None,
    cwd: Optional[Path] = None,
    shell=None,
    inputs: Optional[dict] = None,
    check_only: bool = False,
    approved: bool = False,
    on_change: Optional[OnChange] = None,
    phase: str = "setup",
    **seams,
) -> SetupTreeResult:
    """Set up ``root_id`` (or, ``check_only``, say whether it is). Never raises for an outcome.

    ``resolve_op`` / ``resolve_wizard`` default to the indexes (``ComputeOp`` / ``Wizard`` by name, each
    with its own trust). ``seams`` reach ``setup_tree`` untouched (``launch``, ``platform``) — tests.

    ``phase="load"`` runs the root's ``on_load`` wizard alone, in the SAME slot and record as its setup: a
    load and a setup of one node touch the same thing, so one holds while the other goes, and the screen
    that follows the node's setup follows its load too.
    """
    from flow_sdk.core.wizard.execute import _resolve_op, _resolve_wizard  # noqa: PLC0415 — entity layer

    resolvers = dict(resolve_op=resolve_op or _resolve_op, resolve_wizard=resolve_wizard or _resolve_wizard)
    if check_only:
        return await setup_tree(
            root_id, resolve_node=resolve_node, subject_entity=subject_entity, workdir=cwd, shell=shell,
            inputs=inputs, check_only=True, approved=approved, phase=phase, **resolvers, **seams,
        )

    key = run_key(SETUP_RUN, root_id)
    workdir = run_dir(key)
    workdir.mkdir(parents=True, exist_ok=True)
    # TRY-acquire, never wait: a setup lasts as long as a person takes to answer, and a second caller
    # must hear "already running" now. Not a timeout budget — there is no wait to widen.
    from filelock import FileLock, Timeout  # noqa: PLC0415

    lock = FileLock(str(workdir / "run.lock"))
    try:
        lock.acquire(blocking=False)
    except Timeout:
        return SetupTreeResult(state=SetupState.HELD, detail=f"{root_id} is already being set up on this machine.")

    async def changed(tree: SetupTreeResult) -> None:
        # The lock above is held for the whole run — re-taking it here would self-deadlock (``_mutate``).
        record_tree(key, tree, already_locked=True)
        if on_change is not None:
            await on_change(tree)

    from flow_sdk.core.compute_op.ask import ASKING_RUN  # noqa: PLC0415

    activity_path = setup_activity_path(root_id)
    asking = ASKING_RUN.set(activity_path)  # a question any node asks names THIS run
    try:
        result = await setup_tree(
            root_id, resolve_node=resolve_node, activity_path=activity_path, subject_entity=subject_entity,
            workdir=cwd or workdir, shell=shell, inputs=inputs, approved=approved, wizard_id=SETUP_RUN,
            on_change=changed, phase=phase, **resolvers, **seams,
        )
        record_tree(key, result, already_locked=True)
    finally:
        ASKING_RUN.reset(asking)
        lock.release()
    if on_change is not None:
        await on_change(result)
    return result
