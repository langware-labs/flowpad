"""The monitor's fatal-failure record — ``<instance>/server-failure.json``.

Written by the supervisor (``flow_sdk/server/launch.py``) when a backend death is
classified deterministic, read by the next supervisor (``refuse_start_reason``) and
by the desktop app (``electron/fatal-failure.js``). It travels between the Python
tier and Electron, so it is a value of a ``DataSpec`` schema: the field list below
IS the on-disk shape, and a record that does not fit it is rejected on load.

The two sides are tested against the same sample
(``electron/fixtures/server-failure.sample.json``, test 15 on each side).
"""

from __future__ import annotations

from typing import Any, ClassVar, Optional

from pydantic import ConfigDict, Field

from flow_sdk.schema.data_spec.spec import DataSpec

#: Bump when the record's shape changes incompatibly; the desktop app checks it.
SCHEMA_VERSION = 1


class RuntimeFingerprint(DataSpec):
    """What has to change before the same failure is worth trying again."""

    spec_kind: ClassVar[str] = "server.runtime_fingerprint"

    hash: str
    python: str
    engine_version: str
    platform: str


class ServerFailureRecord(DataSpec):
    spec_kind: ClassVar[str] = "server.failure_record"

    # ``schema`` on disk (what Electron reads); the field cannot be called that in a
    # pydantic model (``BaseModel.schema`` exists), hence the alias.
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    schema_version: int = Field(default=SCHEMA_VERSION, alias="schema")
    kind: str
    fatal: bool
    repairable: bool
    reason: str
    module: Optional[str] = None
    excerpt: Optional[str] = None
    traceback: Optional[str] = None
    #: 'server-log' | 'spawn' | 'repetition'
    source: str = "server-log"
    exit_code: Optional[int] = None
    evidence: dict[str, Any] = {}
    attempts: int
    restarts_stopped: bool
    fingerprint: RuntimeFingerprint
    engine_version: Optional[str] = None
    server_log: Optional[str] = None
    at: str
    monitor_pid: Optional[int] = None

    def as_json(self) -> dict:
        """The on-disk form: plain JSON types, ``schema`` under its wire name."""
        return self.model_dump(mode="json", by_alias=True)

    @classmethod
    def from_json(cls, data: Any) -> "ServerFailureRecord":
        """Validate a loaded record (raises ``pydantic.ValidationError`` on a foreign shape)."""
        return cls.model_validate(data)
