"""The ``/fs-records/index`` handler as a test drives it — the route's request
shape and the compute node's mixin — shared by every handler test."""
from __future__ import annotations

from flow_sdk.builtin.faas.fs_records_actions import FsRecordsActionsMixin
from flow_sdk.builtin.faas.in_process_activity import InProcessActivity


class FakeQueryParams:
    def __init__(self, params: dict):
        self._p = params

    def get(self, key, default=None):
        """Mirror Starlette's QueryParams.get — absent key yields ``default``,
        which is ``None`` unless the caller asks otherwise.

        This default is load-bearing, not cosmetic. `_handle_fs_records_index`
        branches on ``qp.get("user") is not None``; with a ``""`` default every
        request looked like it carried an explicit scope, so the whole fake
        suite took the `resolve_project_scope` branch and NEVER exercised the
        `get_all_scope_filter(create_missing=True)` path the real endpoint uses.
        """
        return self._p.get(key, default)


class FakeRequest:
    def __init__(self, params: dict):
        self.query_params = FakeQueryParams(params)


class FakeRequestInfo:
    def __init__(self, params: dict):
        self.request = FakeRequest(params)


class _Handler(FsRecordsActionsMixin):
    def __init__(self):
        self.typeid = "test-compute-node"
        self._activity: InProcessActivity | None = None

    def _start_activity(self, job_name: str, timeout_seconds: int = 600):
        self._activity = InProcessActivity(
            job_name=job_name, entity_id=self.typeid,
            timeout_seconds=timeout_seconds,
        )
        return self._activity

    def _complete_activity(self, job_name: str) -> None:
        self._activity = None
