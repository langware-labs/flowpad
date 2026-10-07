"""``flow.json`` on disk — read, write, and the per-field readers.

Pure functions over a project root (``Path``): no DB, no ``Entity``. Writes are
serialized across processes by a file lock and land atomically; a byte-identical
write is skipped. Reads never raise for the hot-path readers (a project whose file is
broken still opens, it just declares nothing); :func:`read_strict` is the one reader
that reports why.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from pydantic import ValidationError

from flow_sdk.capsules.atomic import atomic_write, capsule_lock
from flow_sdk.schema.data_spec.flow_json_spec import FLOW_JSON, FlowDependency, FlowJsonSpec


class FlowJsonError(ValueError):
    """The file exists but cannot be read as a ``flow.json``."""


def flow_json_path(root: Path) -> Path:
    return Path(root) / FLOW_JSON


def parse(text: str) -> FlowJsonSpec:
    try:
        data = json.loads(text)
    except ValueError as exc:
        raise FlowJsonError(f"{FLOW_JSON} is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise FlowJsonError(f"{FLOW_JSON} must be a JSON object")
    try:
        return FlowJsonSpec.model_validate(data)
    except ValidationError as exc:
        problems = "; ".join(f"{'.'.join(str(p) for p in e['loc']) or 'root'}: {e['msg']}" for e in exc.errors())
        raise FlowJsonError(f"{FLOW_JSON}: {problems}") from exc


def read_strict(root: Path) -> Optional[FlowJsonSpec]:
    """The file under ``root``, ``None`` when there is none; raises :class:`FlowJsonError`."""
    try:
        text = flow_json_path(root).read_text(encoding="utf-8")
    except (FileNotFoundError, NotADirectoryError):
        return None
    return parse(text)


def read(root: Optional[Path]) -> FlowJsonSpec:
    """The file, or an empty spec when there is none OR it cannot be read. Never raises."""
    if not root:
        return FlowJsonSpec()
    try:
        return read_strict(Path(root)) or FlowJsonSpec()
    except (FlowJsonError, OSError):
        return FlowJsonSpec()


def render(spec: FlowJsonSpec) -> bytes:
    return (json.dumps(spec.to_document(), indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def _update(root: Path, change) -> FlowJsonSpec:
    """Read-modify-write under the cross-process lock. A broken file is refused
    rather than overwritten — a person's hand edit is never thrown away."""
    path = flow_json_path(root)
    with capsule_lock(path):
        current = read_strict(root)
        spec = change(current or FlowJsonSpec())
        rendered = render(spec)
        if current is None and not spec.to_document():
            return spec   # nothing to declare and no file: never create an empty one
        try:
            if path.read_bytes() == rendered:
                return spec
        except FileNotFoundError:
            pass
        atomic_write(path, rendered, new_mode=0o644)
        return spec


def write_dependency(root: Path, dep: FlowDependency) -> FlowJsonSpec:
    return _update(root, lambda spec: spec.with_dependency(dep))


def drop_dependency(root: Path, name: str) -> FlowJsonSpec:
    return _update(root, lambda spec: spec.without(name))


def read_autolaunch_journey(root: Optional[Path]) -> Optional[str]:
    return read(root).autolaunch_journey


def read_always_use_skills(root: Optional[Path]) -> tuple[str, ...]:
    return tuple(read(root).always_use_skills)


__all__ = [
    "FlowJsonError",
    "drop_dependency",
    "flow_json_path",
    "parse",
    "read",
    "read_always_use_skills",
    "read_autolaunch_journey",
    "read_strict",
    "render",
    "write_dependency",
]
