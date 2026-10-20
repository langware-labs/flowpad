"""Where a dataset's rows live -- ``dataset.json`` ``location``.

The app ships the SHAPE (kinds, rules, viewers) and the DRIVERS; the rows live wherever the person
puts them. One field says where::

    "location": "local"                      # default: <dataset>/rows/, kept out of git
    "location": "file:~/data/leads"          # a folder on this machine (rows/ inside it)
    "location": "s3:my-bucket/gtm/leads"     # a driver whose source is ``RowFiles``
    "location": {"driver": "twenty", "config": {"resource": "companies"},
                 "map": {"key": "external_id", "input": {...}}, "by": "crm"}   # a record system

A file location (local, a folder, or a ``RowFiles`` driver: Drive, S3) holds the row layout as it is
on disk -- ``rows/<key>/row.json`` and the slot files beside it. A record location (a driver whose
source is ``Mutable`` and listable: Twenty) holds one record per row, shaped by ``map``.

Rows are always READ and WRITTEN through a local folder -- the dataset's own for ``local``, the
named one for ``file:``, and for a remote location a disposable WORKING COPY under this instance
(``<instance>/cache/rows/<dataset id>/``), never a second truth and never in a project. A remote
working copy is brought up to date by ``pull`` and its changes sent by ``push``:

* files: ``row.json`` is a row's COMMIT POINT -- slots are sent first and ``row.json`` last, as a
  write conditioned on the version last seen (``Conflict`` when someone else wrote it since). A row
  folder out there without ``row.json`` is not read (an interrupted write).
* records: a pull re-mirrors every record into the working copy (``Dataset.mirror``); a write goes
  to the record system first (``datasets.projection.write_through``), so there is nothing to push.
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import hashlib
import json
import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator, Callable, Optional

logger = logging.getLogger(__name__)

LOCAL, FOLDER, FILES, RECORDS = "local", "folder", "files", "records"
_DRIVER = re.compile(r"^([a-z][a-z0-9_]*):(.*)$")
#: The working copy's own record of what it last saw out there: ``{path: {"v": version, "h": hash}}``.
STATE_FILE = ".location.json"


@dataclass(frozen=True)
class Location:
    kind: str
    driver: str = ""
    target: str = ""
    config: dict = field(default_factory=dict)
    map: Optional[dict] = None
    by: Optional[str] = None
    read_only: bool = False
    raw: Any = None

    @property
    def remote(self) -> bool:
        return self.kind in (FILES, RECORDS)

    def label(self) -> str:
        """How the location reads to a person (and in a log)."""
        if self.kind == LOCAL:
            return LOCAL
        if self.kind == FOLDER:
            return f"file:{self.target}"
        return f"{self.driver}:{self.target}" if self.target else self.driver


def parse(value: Any) -> Location:
    """A ``location`` as written in ``dataset.json`` → ``Location``; ``ValueError`` naming what is wrong."""
    if value in (None, "", LOCAL):
        return Location(LOCAL, raw=LOCAL)
    if isinstance(value, str):
        if value.startswith("file:"):
            path = value[len("file:"):].strip()
            if not path:
                raise ValueError("location: file: needs a folder (file:~/data/leads)")
            return Location(FOLDER, target=str(Path(path).expanduser()), raw=value)
        found = _DRIVER.match(value.strip())
        if not found:
            raise ValueError(f"location: {value!r} is not local, file:<folder> or <driver>:<target>")
        return Location(FILES, driver=found.group(1), target=found.group(2).strip(), raw=value)
    if isinstance(value, dict):
        unknown = set(value) - {"driver", "target", "config", "map", "by", "read_only"}
        if unknown or not isinstance(value.get("driver"), str) or not _DRIVER.match(f"{value['driver']}:"):
            raise ValueError('location: {"driver", "target"?, "config"?, "map"?, "by"?, "read_only"?} is required')
        config = {} if value.get("config") is None else value["config"]
        if not isinstance(config, dict):
            raise ValueError("location.config: an object is required")
        shape = value.get("map")
        if shape is not None:
            from flow_sdk.datasets.projection import check_map  # noqa: PLC0415

            check_map(shape)
        by = value.get("by")
        if by is not None and not isinstance(by, str):
            raise ValueError("location.by: one word, as a schema's `owned_by` (\"crm\")")
        return Location(RECORDS if shape is not None else FILES, driver=value["driver"], target=str(value.get("target") or ""),
                        config=dict(config), map=shape, by=by, read_only=bool(value.get("read_only")), raw=value)
    raise ValueError("location: a string or an object is required")


def rows_root(folder: Path | str, location: Location, dataset_id: str) -> Path:
    """The local folder whose ``rows/`` the row code reads and writes, for the dataset in ``folder``."""
    if location.kind == LOCAL:
        return Path(folder)
    if location.kind == FOLDER:
        return Path(location.target)
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    return get_instance_settings().instance_dir / "cache" / "rows" / (dataset_id or _digest(str(folder).encode()))


def rows_folder(dataset: Any, location: Location) -> Path:
    return rows_root(dataset.asset_ref, location, str(dataset.id or ""))


def rows_root_of(folder: Path | str, header: Optional[dict] = None, dataset_id: Optional[str] = None) -> Path:
    """``rows_root`` for a dataset read from disk alone: its ``location`` from ``header`` (the
    manifest's metadata) or from ``dataset.json``, its id from the folder's identity. A location that
    does not parse reads as local (the dataset's own folder): a bad manifest never moves the rows."""
    folder = Path(folder)
    if header is None:
        from flow_sdk.schema.data_spec.layout import load_doc  # noqa: PLC0415

        header = load_doc(folder / "dataset.json")[0]
    try:
        location = parse(header.get("location"))
    except ValueError:
        return folder
    if location.kind == LOCAL:
        return folder
    if dataset_id is None and location.remote:
        from flow_sdk.schema.data_spec.io.identity import FolderCapsule  # noqa: PLC0415

        dataset_id = FolderCapsule().read(folder) or ""
    return rows_root(folder, location, dataset_id or "")


# ── opening a driver as a store ───────────────────────────────────────────────────────────────────

#: A test double's seam: ``(location) -> async context manager yielding the opened source``.
OPENER: Optional[Callable[[Location], Any]] = None


async def project_of(dataset: Any) -> str:
    """The id of the project a dataset belongs to: where the location's driver finds the credential its
    manifest names (a credential declared in that project, else the user's)."""
    if getattr(dataset, "project_id", None):
        return str(dataset.project_id)
    from flow_sdk.context import current_project  # noqa: PLC0415

    try:
        project = await current_project(cwd=str(dataset.asset_ref)) if getattr(dataset, "asset_ref", "") else None
    except Exception:  # noqa: BLE001 -- no index to ask (a bare script): the user's credentials alone
        project = None
    return str(project.id) if project is not None else ""


@contextlib.asynccontextmanager
async def opened(location: Location, project_id: str = "") -> AsyncIterator[Any]:
    """The location's driver, configured and opened, as its source (``RowFiles`` or ``Mutable``).
    Credentials come from what the driver's manifest names, as for any source of it, looked up in
    ``project_id``'s scope (then the user's)."""
    if OPENER is not None:
        async with OPENER(location) as source:
            yield source
        return
    from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415

    driver = await DataDriver.get(location.driver)
    config = dict(location.config)
    if location.target:
        target_of = getattr(driver.cls, "row_files_target", None)
        if target_of is None:
            raise ValueError(f"location: the {location.driver} driver cannot hold rows at {location.target!r}")
        config.update(target_of(location.target))
    source = driver.create_source(config, name=f"rows at {location.label()}", **({"project_id": project_id} if project_id else {}))
    async with await source.open() as live:
        yield live.source


# ── the working copy ──────────────────────────────────────────────────────────────────────────────

def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:16]


def _local_files(root: Path) -> dict[str, Path]:
    """Every row file of the working copy, by its path relative to ``root`` (``rows/...``)."""
    out: dict[str, Path] = {}
    base = root / "rows"
    if not base.is_dir():
        return out
    for here, dirs, files in os.walk(base):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for name in files:
            if not name.startswith("."):
                path = Path(here) / name
                out[path.relative_to(root).as_posix()] = path
    return out


def _row_of(path: str) -> Optional[str]:
    """``acme`` for ``rows/acme/input/x.json``; None for anything outside a row folder."""
    parts = path.split("/")
    return parts[1] if len(parts) >= 3 and parts[0] == "rows" else None


def _seen(root: Path, location: Location) -> dict:
    """What the working copy last saw at ``location``: ``{path: {"v": version, "h": hash}}`` -- empty
    for a copy of another location (or none yet)."""
    from flow_sdk.schema.data_spec.layout import load_json_dict  # noqa: PLC0415

    state = load_json_dict(root / STATE_FILE)
    files = state.get("files")
    return files if state.get("location") == location.raw and isinstance(files, dict) else {}


def _save_state(root: Path, location: Location, files: dict) -> None:
    from flow_sdk.instances.atomic import write_json_atomic  # noqa: PLC0415

    root.mkdir(parents=True, exist_ok=True)
    write_json_atomic(root / STATE_FILE, {"location": location.raw, "files": files})


async def pull_files(store: Any, root: Path, location: Location) -> list[str]:
    """Make the working copy ``root`` hold exactly what the store holds: a file changed out there,
    or changed here without being pushed, is read again; one gone out there goes here. A row out
    there without ``row.json`` is skipped. Returns the keys of the rows that moved."""
    seen = _seen(root, location)
    remote = await store.list_files()
    committed = {_row_of(p) for p in remote if p.endswith("/row.json") and p.count("/") == 2}
    remote = {p: v for p, v in remote.items() if _row_of(p) in committed}
    local = _local_files(root)
    files, moved = {}, set()
    for path, version in remote.items():
        held = seen.get(path) or {}
        here = local.get(path)
        current = here is not None and held.get("v") == version and _digest(here.read_bytes()) == held.get("h")
        if current:
            files[path] = held
            continue
        data = await store.read_file(path)
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        files[path] = {"v": version, "h": _digest(data)}
        moved.add(_row_of(path))
    for path, here in local.items():
        if path not in remote:
            here.unlink(missing_ok=True)
            moved.add(_row_of(path))
    _prune_empty(root / "rows")
    _save_state(root, location, files)
    return sorted(k for k in moved if k)


def _prune_empty(base: Path) -> None:
    if not base.is_dir():
        return
    for here, dirs, files in os.walk(base, topdown=False):
        path = Path(here)
        if path != base and not any(path.iterdir()):
            path.rmdir()


async def push_files(store: Any, root: Path, location: Location) -> list[str]:
    """Send what changed in the working copy since the last pull or push: per row, its slot files
    first and ``row.json`` LAST, conditioned on the version last seen; a row gone here goes out
    there, ``row.json`` last again. ``Conflict`` when another writer moved a row since -- what was
    sent of that row stays out there, and the caller pulls. Returns the keys sent."""
    from flow_sdk.sources.errors import Conflict  # noqa: PLC0415

    seen = _seen(root, location)
    local = {path: here.read_bytes() for path, here in _local_files(root).items()}
    changed: dict[str, dict[str, Optional[bytes]]] = {}
    for path, data in local.items():
        if (seen.get(path) or {}).get("h") != _digest(data):
            changed.setdefault(_row_of(path) or "", {})[path] = data
    for path in seen:
        if path not in local:
            changed.setdefault(_row_of(path) or "", {})[path] = None
    changed.pop("", None)
    if not changed:
        return []
    remote = await store.list_files()
    files = dict(seen)
    for key, paths in sorted(changed.items()):
        meta = f"rows/{key}/row.json"
        expected = (seen.get(meta) or {}).get("v", "")
        if remote.get(meta, "") != expected:
            raise Conflict(f"row {key!r} changed at {location.label()} since it was read")
        gone = meta not in local
        for path, data in sorted(paths.items()):
            if path == meta:
                continue
            if data is None:
                await store.delete_file(path)
                files.pop(path, None)
            else:
                files[path] = {"v": await store.write_file(path, data), "h": _digest(data)}
        if gone:
            # the rest of the row folder goes too: files here never seen are not ours to keep
            for path in [p for p in remote if _row_of(p) == key and p != meta and p not in paths]:
                await store.delete_file(path)
                files.pop(path, None)
            if meta in remote:
                await store.delete_file(meta, expected=expected)
            files.pop(meta, None)
        else:
            data = local[meta]
            files[meta] = {"v": await store.write_file(meta, data, expected=expected), "h": _digest(data)}
    _save_state(root, location, files)
    return sorted(changed)


# ── records ──────────────────────────────────────────────────────────────────────────────────────

class RecordSystem:
    """A record location, opened per call: what ``datasets.projection`` writes through."""

    def __init__(self, location: Location, project_id: str = "", dataset: Any = None) -> None:
        self.location, self.project_id, self.dataset = location, project_id, dataset
        self.provider = location.driver
        self.map = location.map or {}
        self.by = location.by or location.driver

    @contextlib.asynccontextmanager
    async def _open(self) -> AsyncIterator[Any]:
        """The driver opened in the dataset's project (found once, on first use)."""
        if not self.project_id and self.dataset is not None:
            self.project_id = await project_of(self.dataset)
        async with opened(self.location, self.project_id) as source:
            yield source

    def _writable(self, verb: str) -> None:
        if self.location.read_only:
            raise PermissionError(f"these rows are read-only: nothing is {verb}d in {self.provider}")

    @contextlib.asynccontextmanager
    async def _mutable(self, verb: str) -> AsyncIterator[Any]:
        """The driver opened for a write it must be able to make (``Mutable``), refused before any I/O
        on a read-only location."""
        from flow_sdk.sources.protocols import Mutable  # noqa: PLC0415

        self._writable(verb)
        async with self._open() as source:
            if not isinstance(source, Mutable):
                raise NotImplementedError(f"the {self.provider} driver cannot {verb} a record")
            yield source

    def _written(self, item: Any) -> dict:
        return {**self._flat(item), "warnings": list(item.warnings or [])}

    def _flat(self, item: Any) -> dict:
        """A record as the flat envelope ``map`` paths read (``external_id``, ``name``, ``data.<field>``)."""
        from flow_sdk.ingest.envelope_lift import envelope_of  # noqa: PLC0415

        return envelope_of(item, data_source_id=self.location.label(), provider=self.provider).model_dump(mode="json")

    async def records(self) -> list[dict]:
        """Every record, flat (``external_id``, ``data.<field>``): what ``map`` paths read."""
        async with self._open() as source:
            return [self._flat(item) async for item in source.iterate()]

    async def get(self, external_id: Any) -> Optional[dict]:
        from flow_sdk.sources.values.origin import CloudOrigin  # noqa: PLC0415

        if external_id in (None, ""):
            return None
        async with self._open() as source:
            origin = source.origin(str(external_id)) if hasattr(source, "origin") else CloudOrigin(kind="record", namespace="", key=str(external_id))
            item = await source.get(origin)
        return self._flat(item) if item is not None else None

    async def create(self, changes: dict) -> dict:
        from typing import get_type_hints  # noqa: PLC0415

        from flow_sdk.sources.values.items import RecordData  # noqa: PLC0415

        async with self._mutable("create") as source:
            try:   # the record shape the driver's own `create(data: ...)` names
                shape = get_type_hints(type(source).create).get("data", RecordData)
            except Exception:  # noqa: BLE001 -- an annotation that does not resolve: the base record
                shape = RecordData
            shape = shape if isinstance(shape, type) and hasattr(shape, "model_validate") else RecordData
            return self._written(await source.create(shape.model_validate(changes)))

    async def update(self, external_id: str, changes: dict) -> dict:
        async with self._mutable("update") as source:
            return self._written(await source.update(source.origin(str(external_id)), dict(changes)))

    async def delete(self, external_id: str) -> None:
        async with self._mutable("delete") as source:
            await source.delete(source.origin(str(external_id)))


# ── one pull, one push, per dataset at a time ────────────────────────────────────────────────────

#: The datasets (by working-copy root) whose rows the current task is already inside a session of:
#: an inner read or write does not pull again, and the outermost session pushes.
_inside: contextvars.ContextVar[frozenset] = contextvars.ContextVar("location_inside", default=frozenset())
_locks: Any = None


def _registry() -> Any:
    global _locks
    if _locks is None:
        from flow_sdk.stream_inbox._locks import new_registry  # noqa: PLC0415

        _locks = new_registry()
    return _locks


def inside(root: Path) -> bool:
    return str(root) in _inside.get()


@contextlib.contextmanager
def entered(root: Path) -> Any:
    """Mark ``root``'s rows as inside a session for the duration (a sync caller that pulled itself)."""
    token = _inside.set(_inside.get() | {str(root)})
    try:
        yield
    finally:
        _inside.reset(token)


@contextlib.asynccontextmanager
async def session(dataset: Any, location: Location, *, write: bool) -> AsyncIterator[Path]:
    """Rows of a remote location for one read or write: pulled first, and -- for a write -- the
    working copy's changes pushed after. Nested sessions on one dataset share the outer one."""
    root = rows_folder(dataset, location)
    if not location.remote or inside(root):
        yield root
        return
    from flow_sdk.stream_inbox._locks import keyed_loop_lock  # noqa: PLC0415

    async with keyed_loop_lock(_registry(), str(root)):
        from flow_sdk.builtin.dataset import ConflictError  # noqa: PLC0415
        from flow_sdk.sources.errors import Conflict  # noqa: PLC0415

        with entered(root):
            try:
                await pull(dataset, location, root)
                yield root
                if write and location.kind == FILES:
                    try:
                        await push(dataset, location, root)
                    except Conflict as exc:
                        raise ConflictError(str(exc)) from exc
            except BaseException:
                if write and location.kind == FILES:
                    with contextlib.suppress(Exception):
                        await pull(dataset, location, root)   # the working copy goes back to what is out there
                raise


async def pull(dataset: Any, location: Location, root: Optional[Path] = None) -> list[str]:
    root = root or rows_folder(dataset, location)
    if location.kind == FILES:
        async with opened(location, await project_of(dataset)) as store:
            return await pull_files(store, root, location)
    if location.kind == RECORDS:
        system = RecordSystem(location, dataset=dataset)
        _check_owned(dataset, system)
        with entered(root):
            done = await dataset.mirror(await system.records(), system.map, by=system.by)
        return sorted({*done.get("created", []), *done.get("updated", []), *done.get("deleted", [])})
    return []


def _check_owned(dataset: Any, system: RecordSystem) -> None:
    """A mapped field is rewritten from the record on every pull. One the schema lets the app write
    too would take an edit and lose it at the next pull -- so the map may only name fields the schema
    says are this system's (``owned_by``): an edit to one goes to the system first."""
    from flow_sdk.builtin.dataset import LinkError  # noqa: PLC0415

    owned = getattr(dataset.row_type.input_type(), "__owned__", None) or {}
    loose = [name for name in system.map.get("input", {}) if owned.get(name) != system.by]
    if loose:
        raise LinkError([{"path": "", "code": "not_owned",
                          "message": f"the location's map writes {', '.join(loose)} as {system.by!r}, but the row kind "
                                     f'does not say `"owned_by": "{system.by}"` on {"it" if len(loose) == 1 else "them"}: '
                                     f"an edit made here would be lost at the next pull"}])


async def push(dataset: Any, location: Location, root: Optional[Path] = None) -> list[str]:
    if location.kind != FILES:
        return []
    async with opened(location, await project_of(dataset)) as store:
        return await push_files(store, root or rows_folder(dataset, location), location)


def _write_location(folder: Path, value: Any) -> None:
    """``dataset.json``'s ``location``, rewritten in place (the rest of the file as it was)."""
    from flow_sdk.schema.data_spec.layout import load_doc, write_doc  # noqa: PLC0415

    manifest = folder / "dataset.json"
    metadata, data = load_doc(manifest)
    if value in (None, LOCAL):
        metadata.pop("location", None)
    else:
        metadata["location"] = value
    write_doc(manifest, metadata, data)


# ── moving the rows ──────────────────────────────────────────────────────────────────────────────

def _row_keys(root: Path) -> list[str]:
    """The committed rows of a local rows folder (a row is its folder WITH its ``row.json``)."""
    from flow_sdk.schema.data_spec.layout import ROW_META, _row_dirs  # noqa: PLC0415

    return [p.name for p in _row_dirs(root) if (p / ROW_META).is_file()]


async def move_rows(dataset: Any, value: Any) -> dict:
    """Copy every row of ``dataset`` to the location ``value``, check the new location holds them all,
    then make it the dataset's location (``dataset.json``). The rows at the old location are left as
    they are -- deleting someone's data is theirs to decide. Refused when the new location already
    holds rows, or is a record system (its records are made by the system, not copied in).
    Returns ``{"from", "to", "rows"}``."""
    import shutil  # noqa: PLC0415

    old, new = parse(dataset.location), parse(value)
    if new.kind == RECORDS:
        raise ValueError("rows move between file locations (local, a folder, Drive, S3); a record system makes its own records")
    if new.label() == old.label():
        return {"from": old.label(), "to": new.label(), "rows": len(_row_keys(rows_folder(dataset, old)))}
    async with session(dataset, old, write=False) as source:
        keys = _row_keys(source)
        target = rows_root(dataset.asset_ref, new, f"{dataset.id}-{_digest(json.dumps(new.raw, sort_keys=True).encode())}" if new.remote else str(dataset.id))
        if _row_keys(target):
            raise ValueError(f"{new.label()} already holds rows: move into an empty location")
        if new.kind == FILES:
            async with opened(new, await project_of(dataset)) as store:
                if any(_row_of(p) for p in await store.list_files()):
                    raise ValueError(f"{new.label()} already holds rows: move into an empty location")
        if target.resolve() != source.resolve():
            if (target / "rows").exists():
                shutil.rmtree(target / "rows")
            target.mkdir(parents=True, exist_ok=True)
            if (source / "rows").is_dir():
                shutil.copytree(source / "rows", target / "rows")
        if new.kind == FILES:
            async with opened(new, await project_of(dataset)) as store:
                await push_files(store, target, new)
                there = {_row_of(p) for p in await store.list_files() if p.endswith("/row.json")}
        else:
            there = set(_row_keys(target))
        if there != set(keys):
            raise RuntimeError(f"{new.label()} holds {len(there)} rows after the move, not {len(keys)}: the location was not changed")
    dataset.location = None if new.kind == LOCAL else new.raw
    _write_location(Path(dataset.asset_ref), dataset.location)
    if new.remote:   # the new working copy is the one just filled
        final = rows_folder(dataset, new)
        if final.resolve() != target.resolve():
            if final.exists():
                shutil.rmtree(final)
            final.parent.mkdir(parents=True, exist_ok=True)
            target.rename(final)
    await dataset.save()
    return {"from": old.label(), "to": new.label(), "rows": len(keys)}


# ── the gate: rows are data, not the project's code ──────────────────────────────────────────────

def tracked_rows(project_root: Path | str) -> list[str]:
    """The row files git tracks under ``<project>/agentic-assets/dataset/*/rows/`` -- what must be
    empty for a project that ships shape, not data. ``[]`` outside a repo."""
    import subprocess  # noqa: PLC0415

    from flow_sdk.utils.git_usable import git_usable  # noqa: PLC0415

    if not git_usable():
        return []
    try:
        listed = subprocess.run(["git", "ls-files", "-z", "--", "agentic-assets/dataset/*/rows/*"],
                                cwd=str(project_root), capture_output=True, check=False, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return []
    if listed.returncode != 0:
        return []
    return sorted(p for p in listed.stdout.decode("utf-8", "replace").split("\0") if p)
