"""``flow_storage`` -- a data store on the Flowpad hub.

The hub's ``data_store`` entity holds a project's data files; this driver is the desktop's way in. A data
source of it names the store (``store_id``); datasets in that source keep their rows there as
``<prefix>/<dataset>/rows/<key>/row.json`` and the files beside it -- the layout every data store shares, so
rows move to and from Drive or a folder by a plain copy.

It is a ``RowFiles`` store: the dataset machinery pulls a working copy, writes through ``write_file`` with
the version it last read, and the hub refuses (409 → ``Conflict``) a write over someone else's change. No
token of its own: the hub sign-in this instance already has. Signed out or offline, the source owes setup
and its datasets keep their rows locally.
"""
from __future__ import annotations

import base64
from typing import Any, Mapping, Optional

from flow_sdk.cloud_client.hub_proxy import HubProxy
from flow_sdk.cloud_client.shared.errors import HubError
from flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.config import SourceConfig
from flow_sdk.sources.errors import AccessDenied, Conflict, NotFound, SourceUnavailable
from flow_sdk.sources.families import ObjectSource
from flow_sdk.sources.protocols import Verdict
from flow_sdk.sources.setup_steps import SourceUpdateSpec, setup_step

STORE = "data_store"


class FlowStorageConfig(SourceConfig):
    store_id: str = ""
    prefix: str = ""


def _joined(*parts: str) -> str:
    return "/".join(p for part in parts for p in str(part or "").replace("\\", "/").split("/") if p)


def _refusal(exc: HubError, what: str) -> Exception:
    """A hub answer as the source error the dataset machinery understands."""
    if exc.status_code == 409:
        return Conflict(f"{what} changed on the hub since it was read")
    if exc.status_code == 404:
        return NotFound(f"{what} is not in the data store")
    if exc.status_code in (401, 403):
        return AccessDenied(f"the hub refused {what}: {exc.reason}")
    return SourceUnavailable(f"the hub did not answer for {what}: {exc.reason or exc.status_code}")


class FlowStorageSource(ObjectSource):
    """The files of one hub data store (under ``prefix``)."""

    Config = FlowStorageConfig
    provider = "flow_storage"
    stamps_identity = False

    @classmethod
    def namespace_for(cls, binding: SourceBinding) -> str:
        return str(binding.config.get("store_id") or cls.provider)

    @classmethod
    def rows_within(cls, config: dict, path: str) -> dict:
        """A dataset's rows in the folder ``path`` inside this source's folder."""
        return {**config, "prefix": _joined(config.get("prefix") or "", path)}

    @property
    def store_id(self) -> str:
        return str(self.config.get("store_id") or "")

    def _path(self, path: str) -> str:
        return _joined(self.config.get("prefix") or "", path)

    async def _open(self) -> None:
        return None

    async def _close(self) -> None:
        return None

    # ── RowFiles ─────────────────────────────────────────────────────────────
    async def list_files(self) -> dict[str, str]:
        prefix = _joined(self.config.get("prefix") or "")
        try:
            answer = await HubProxy.call("GET", STORE, self.store_id, "files", params={"prefix": prefix})
        except HubError as exc:
            raise _refusal(exc, f"the files of {prefix or 'the store'}") from exc
        base = f"{prefix}/" if prefix else ""
        return {p[len(base):]: str(v) for p, v in (answer.get("files") or {}).items() if p.startswith(base)}

    async def read_file(self, path: str) -> bytes:
        try:
            answer = await HubProxy.call("GET", STORE, self.store_id, "read", params={"path": self._path(path)})
        except HubError as exc:
            raise _refusal(exc, path) from exc
        return base64.b64decode(str(answer.get("data") or ""))

    async def write_file(self, path: str, data: bytes, *, expected: Optional[str] = None) -> str:
        self._require_writable()
        body: dict[str, Any] = {"path": self._path(path), "data": base64.b64encode(bytes(data)).decode()}
        if expected is not None:
            body["expected"] = expected
        try:
            answer = await HubProxy.call("POST", STORE, self.store_id, "write", payload=body)
        except HubError as exc:
            raise _refusal(exc, path) from exc
        return str((answer or {}).get("version") or "")

    async def delete_file(self, path: str, *, expected: Optional[str] = None) -> None:
        self._require_writable()
        body: dict[str, Any] = {"path": self._path(path)}
        if expected is not None:
            body["expected"] = expected
        try:
            await HubProxy.call("POST", STORE, self.store_id, "delete", payload=body)
        except HubError as exc:
            raise _refusal(exc, path) from exc

    # ── setup ────────────────────────────────────────────────────────────────
    async def verify(self) -> Verdict:
        if not self.store_id:
            return Verdict(ready=False, detail="This data source has no data store yet: run its setup to make one.")
        try:
            await HubProxy.call("GET", STORE, self.store_id, "files", params={"prefix": "__none__"})
        except HubError as exc:
            if exc.status_code in (401, 403, 404):
                return Verdict(ready=False, detail=f"The hub data store is not reachable for you ({exc.reason or exc.status_code}).")
            raise SourceUnavailable(f"the hub did not answer: {exc.reason or exc.status_code}") from exc
        return Verdict(ready=True)

    @setup_step("create")
    async def _create(self, *, check: bool, values: Mapping[str, str]) -> ReturnedValue:
        """A data store on the hub for this source, kept in its config (one already named is kept)."""
        if self.store_id:
            return ReturnedValue.satisfied(f"data store {self.store_id}")
        if check:
            return ReturnedValue.not_yet("No data store yet")
        name = str(values.get("name") or self.binding.name or "project data")
        try:
            made = await HubProxy.call("POST", STORE, payload={"name": name})
        except HubError as exc:
            return ReturnedValue.not_yet(f"The hub did not make the data store: {exc.reason or exc.status_code}")
        store_id = str((made or {}).get("id") or "")
        if not store_id:
            return ReturnedValue.not_yet("The hub did not make the data store (sign in to the hub)")
        return ReturnedValue.satisfied(f"data store {store_id}", value=SourceUpdateSpec(config={"store_id": store_id}))


__all__ = ["FlowStorageSource"]
