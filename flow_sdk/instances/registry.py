"""``launcher.json`` CRUD, enumeration, and group derivation.

Group membership is **derived** by bucketing records on their ``group`` field.
There is deliberately no ``groups.json``: a second file describing the same
relationship is a second source of truth, and the whole point of this refactor
is that the launcher's view of the machine stopped matching the machine.
"""

from __future__ import annotations

from . import paths
from .atomic import read_json, write_json_atomic
from .errors import NameInvalid
from .model import LauncherRecord

#: Group bucket for live processes whose instance has no registry at all.
ORPHAN_GROUP = "(orphans)"


def read(name: str) -> LauncherRecord | None:
    """The record for ``name``, or None when absent/unparseable."""
    data = read_json(paths.launcher_path(name))
    if not data:
        return None
    rec = LauncherRecord.from_json(data)
    # A registry whose `name` disagrees with its directory is corrupt
    # bookkeeping; trust the directory, which is what every path derives from.
    if rec.name != name:
        rec = LauncherRecord.from_json({**data, "name": name})
    return rec


def write(rec: LauncherRecord) -> None:
    write_json_atomic(paths.launcher_path(rec.name), rec.to_json())


def delete(name: str) -> bool:
    path = paths.launcher_path(name)
    existed = path.exists()
    path.unlink(missing_ok=True)
    return existed


def exists(name: str) -> bool:
    return paths.launcher_path(name).exists()


def read_server_info(name: str) -> dict:
    """``<instance>/server.json`` — the backend's own record of itself.

    Written by the running backend and deleted on graceful shutdown. It is the
    only evidence for an instance started outside the launcher (``oss``,
    ``prod``), which never has a ``launcher.json``. It is also frequently
    **stale**: the file only gets cleaned up on a graceful uvicorn shutdown, so
    a SIGKILL or a crash leaves it behind pointing at a dead PID. Never treat
    its presence as liveness — check the PID.
    """
    return read_json(paths.server_json_path(name))


def all_records() -> list[LauncherRecord]:
    """Every parseable registry under ``instances/``, sorted by name."""
    out: list[LauncherRecord] = []
    for d in paths.known_instance_dirs():
        rec = read(d.name)
        if rec is not None:
            out.append(rec)
    return sorted(out, key=lambda r: r.name)


def all_known_names() -> set[str]:
    """Every name with *any* on-disk footprint.

    The union of five sources, not just the registries: on the machine that
    prompted this refactor there were 286 instance directories and only 36
    registries, so a sweep driven by registries alone would have missed 250 of
    them. Live processes are added by the caller from the process table.
    """
    names: set[str] = {d.name for d in paths.known_instance_dirs()}
    root = paths.repo_root()
    if root.is_dir():
        for env in root.glob(".env.*.local"):
            candidate = env.name[len(".env."):-len(".local")]
            try:
                names.add(paths.validate_name(candidate))
            except NameInvalid:
                continue
    return names


def groups() -> dict[str, list[LauncherRecord]]:
    """Records bucketed by group name, each bucket sorted by instance name."""
    out: dict[str, list[LauncherRecord]] = {}
    for rec in all_records():
        out.setdefault(rec.group or rec.name, []).append(rec)
    for bucket in out.values():
        bucket.sort(key=lambda r: r.name)
    return dict(sorted(out.items()))


def members_of(group: str) -> list[LauncherRecord]:
    return groups().get(group, [])
