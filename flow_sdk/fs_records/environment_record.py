from __future__ import annotations

import json
from pathlib import Path
from typing import Any, ClassVar

from flow_sdk.fs_store import Record, RecordType
from flow_sdk.fs_store.fs_ref import JSONFsRef


class EnvironmentRecord(Record):
    """Record for execution environment configuration."""

    _record_type: ClassVar[str] = RecordType.ENVIRONMENT
    def __init__(self, **kwargs: Any):
        kwargs.setdefault("type", RecordType.ENVIRONMENT)
        super().__init__(**kwargs)

    # ------------------------------------------------------------------
    # env_vars (dict)
    # ------------------------------------------------------------------

    @property
    def env_vars_ref(self) -> JSONFsRef | None:
        """Named FSRef child for the env_vars dict (data/env_vars.json).

        Returns None when the record has no folder on disk yet.
        """
        rdd = self.record_data_dir
        if rdd is None:
            return None
        return JSONFsRef(rdd / "env_vars.json")

    @property
    def env_vars(self) -> dict[str, str]:
        return object.__getattribute__(self, "__dict__").get("env_vars") or {}

    @env_vars.setter
    def env_vars(self, value: dict[str, str]) -> None:
        object.__getattribute__(self, "__dict__")["env_vars"] = value
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add("env_vars")
        ref = self.env_vars_ref
        if ref is not None:
            ref.update(value)

    # ------------------------------------------------------------------
    # work_dir (str scalar)
    # ------------------------------------------------------------------

    @property
    def work_dir_ref(self) -> JSONFsRef | None:
        """Named FSRef child for work_dir (data/work_dir.json)."""
        rdd = self.record_data_dir
        return JSONFsRef(rdd / "work_dir.json") if rdd is not None else None

    @property
    def work_dir(self) -> str:
        return object.__getattribute__(self, "__dict__").get("work_dir") or ""

    @work_dir.setter
    def work_dir(self, value: str) -> None:
        object.__getattribute__(self, "__dict__")["work_dir"] = value
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add("work_dir")
        ref = self.work_dir_ref
        if ref is not None:
            Path(ref.path).parent.mkdir(parents=True, exist_ok=True)
            Path(ref.path).write_text(
                json.dumps({"data": value}, ensure_ascii=False),
                encoding="utf-8",
            )

    # ------------------------------------------------------------------
    # shell (str scalar)
    # ------------------------------------------------------------------

    @property
    def shell_ref(self) -> JSONFsRef | None:
        """Named FSRef child for shell (data/shell.json)."""
        rdd = self.record_data_dir
        return JSONFsRef(rdd / "shell.json") if rdd is not None else None

    @property
    def shell(self) -> str:
        return object.__getattribute__(self, "__dict__").get("shell") or ""

    @shell.setter
    def shell(self, value: str) -> None:
        object.__getattribute__(self, "__dict__")["shell"] = value
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add("shell")
        ref = self.shell_ref
        if ref is not None:
            Path(ref.path).parent.mkdir(parents=True, exist_ok=True)
            Path(ref.path).write_text(
                json.dumps({"data": value}, ensure_ascii=False),
                encoding="utf-8",
            )

    # ------------------------------------------------------------------
    # compute_node_id (str | None scalar)
    # ------------------------------------------------------------------

    @property
    def compute_node_id_ref(self) -> JSONFsRef | None:
        """Named FSRef child for compute_node_id (data/compute_node_id.json)."""
        rdd = self.record_data_dir
        return JSONFsRef(rdd / "compute_node_id.json") if rdd is not None else None

    @property
    def compute_node_id(self) -> str | None:
        return object.__getattribute__(self, "__dict__").get("compute_node_id")

    @compute_node_id.setter
    def compute_node_id(self, value: str | None) -> None:
        object.__getattribute__(self, "__dict__")["compute_node_id"] = value
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add("compute_node_id")
        ref = self.compute_node_id_ref
        if ref is not None:
            Path(ref.path).parent.mkdir(parents=True, exist_ok=True)
            Path(ref.path).write_text(
                json.dumps({"data": value}, ensure_ascii=False),
                encoding="utf-8",
            )
