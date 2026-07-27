"""Named JSON capsules stored inside an asset folder."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .atomic import atomic_write, capsule_lock
from .base import AssetCapsule
from .data import CapsuleData, validate_capsule_name
from .errors import DuplicateCapsuleError, MalformedCapsuleError


def _reject_duplicate_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in pairs:
        if key in out:
            raise DuplicateCapsuleError(f"duplicate JSON key: {key}")
        out[key] = value
    return out


class FolderCapsule(AssetCapsule):
    def _capsule_path(self, name: str) -> Path:
        validate_capsule_name(name)
        flow = self.path / ".flow"
        capsules = flow / "capsules"
        for component in (flow, capsules):
            if component.is_symlink():
                raise MalformedCapsuleError(f"capsule directory must not be a symlink: {component}")
        target = capsules / f"{name}.json"
        if target.is_symlink():
            raise MalformedCapsuleError(f"capsule file must not be a symlink: {target}")
        return target

    def read(self, name: str) -> CapsuleData | None:
        target = self._capsule_path(name)
        try:
            raw = target.read_text(encoding="utf-8")
        except FileNotFoundError:
            return None
        except (OSError, UnicodeError) as exc:
            raise MalformedCapsuleError(str(exc)) from exc
        try:
            value = json.loads(raw, object_pairs_hook=_reject_duplicate_pairs)
        except DuplicateCapsuleError:
            raise
        except (TypeError, ValueError) as exc:
            raise MalformedCapsuleError(str(exc)) from exc
        if not isinstance(value, dict):
            raise MalformedCapsuleError("capsule JSON root must be an object")
        return CapsuleData.from_dict(value)

    def write(self, name: str, data: CapsuleData) -> CapsuleData:
        target = self._capsule_path(name)
        with capsule_lock(target):
            existing = self.read(name)
            if existing == data:
                return existing
            encoded = (json.dumps(data.to_dict(), indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode()
            atomic_write(target, encoded)
            committed = self.read(name)
            assert committed is not None
            return committed

    def write_if_absent(self, name: str, data: CapsuleData) -> CapsuleData:
        target = self._capsule_path(name)
        with capsule_lock(target):
            existing = self.read(name)
            if existing is not None:
                return existing
            encoded = (json.dumps(data.to_dict(), indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode()
            atomic_write(target, encoded)
            committed = self.read(name)
            assert committed is not None
            return committed

    def remove(self, name: str) -> bool:
        target = self._capsule_path(name)
        with capsule_lock(target):
            self.read(name)  # fail closed on corrupt data
            try:
                target.unlink()
                return True
            except FileNotFoundError:
                return False

    def names(self) -> tuple[str, ...]:
        root = self.path / ".flow" / "capsules"
        if not root.exists():
            return ()
        if root.is_symlink() or not root.is_dir():
            raise MalformedCapsuleError(f"invalid capsule directory: {root}")
        names: list[str] = []
        for candidate in root.glob("*.json"):
            name = validate_capsule_name(candidate.stem)
            self.read(name)
            names.append(name)
        return tuple(sorted(names))
