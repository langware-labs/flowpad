"""One run at a time, for a script that writes many rows.

Row writes are safe between writers (one lock per project, ``expected=`` versions), but a RUN is
more than its writes: a mirror of an outside system reads that system, decides, writes rows, then
saves what both sides agreed on. Two runs at once (a trigger's every 15 minutes and a person's
"Sync now") would each decide on the same reading, remove the same rows and overwrite each other's
state. ``single_run`` gives a script the whole run to itself::

    from flow_sdk.datasets.run import single_run

    with single_run(project_root, "crm-sync"):
        ...   # read the outside system, ds.sync(rows), save the state

The lock is a file under ``<project>/.flow/runs/`` (Flowpad's own folder, never in git), held across
processes. A second run WAITS by default and then runs on what the first left; ``wait=False`` raises
``RunBusy`` at once instead -- for a caller that would rather skip this round than queue.
"""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from flow_sdk.schema.data_spec.layout import check_key


class RunBusy(RuntimeError):
    """``single_run(..., wait=False)``: another run of this name holds the project right now."""


def run_lock_path(owner: Path | str, name: str) -> Path:
    """Where the lock of the run ``name`` lives for the project at ``owner``."""
    return Path(owner) / ".flow" / "runs" / f"{check_key(name)}.lock"


@contextmanager
def single_run(owner: Path | str, name: str, *, wait: bool = True) -> Iterator[None]:
    """Hold the project's run ``name`` for the block: no other process runs it meanwhile. ``name``
    is a row-key-like word (``a-z 0-9 _ -``), one per script. NOT re-entrant: a run does not start
    itself again from inside."""
    from filelock import FileLock, Timeout  # noqa: PLC0415

    path = run_lock_path(owner, name)
    path.parent.mkdir(parents=True, exist_ok=True)
    lock = FileLock(str(path))
    try:
        lock.acquire(timeout=-1 if wait else 0)
    except Timeout:
        raise RunBusy(f"another {name!r} run is in progress for {owner}") from None
    try:
        yield
    finally:
        lock.release()


__all__ = ["RunBusy", "run_lock_path", "single_run"]
