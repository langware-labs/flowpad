"""The hub's ``project/<id>/git_share`` action, played for desk-side tests.

``HubDouble`` answers ``hub_get/hub_post/hub_delete/hub_put`` the way the hub does
and checks every request the desk sends: the entity, the id, the action and, for
``POST``, that the repo is named by its GitHub ``owner/name``.
"""

from __future__ import annotations

import uuid

from flow_sdk.db.drivers.db_base_record import BuiltinEntityType

HUB = "flow_sdk.cloud_client.transport.hub_http"


class HubDouble:
    """The hub's ``project/<id>/git_share`` action, and the git origin it records."""

    def __init__(self, project_id: str, *, answer: str = "shared", clone_url: str = "") -> None:
        self.project_id = project_id
        self.answer = answer
        self.git_repo = f"git_repo-{uuid.uuid4()}"
        self.clone_url = clone_url or f"https://hub.test/api/v1/graph/{self.git_repo.replace('-', '/', 1)}/git"
        self.shared = False
        self.calls: list[tuple] = []
        self.git_origin: dict | None = None

    def _state(self) -> dict:
        if self.shared:
            return {
                "status": "shared",
                "repo": "acme/api",
                "git_repo": self.git_repo,
                "clone_url": self.clone_url,
                "default_branch": "main",
            }
        return {"status": "not_shared", "repo": "acme/api"}

    def _route(self, etype, eid, action) -> None:
        assert (etype, str(eid), action) == (BuiltinEntityType.PROJECT, self.project_id, "git_share")

    async def get(self, etype, eid=None, action=None, *_a, **_k):
        self._route(etype, eid, action)
        self.calls.append(("GET",))
        return self._state()

    async def post(self, etype, payload, eid=None, action=None, *_a, **_k):
        self._route(etype, eid, action)
        self.calls.append(("POST", payload))
        assert payload == {"repo": "acme/api"}, "the SDK names the repo by its GitHub owner/name"
        if self.answer == "install_required":
            return {
                "status": "install_required",
                "repo": "acme/api",
                "install_url": "https://github.com/apps/flowpad/installations/new",
            }
        if self.answer in ("github_connect_required", "not_private"):
            return {"status": self.answer, "repo": "acme/api"}
        self.shared = True
        return self._state()

    async def delete(self, etype, eid, action=None, *_a, **_k):
        self._route(etype, eid, action)
        self.calls.append(("DELETE",))
        self.shared = False
        return self._state()

    async def put(self, etype, eid, body, *_a, **_k):
        assert (etype, str(eid)) == (BuiltinEntityType.PROJECT, self.project_id)
        self.calls.append(("PUT", body))
        self.git_origin = body["git_origin"]
        return body

    def install(self, monkeypatch) -> "HubDouble":
        for name, fn in (
            ("hub_get", self.get),
            ("hub_post", self.post),
            ("hub_delete", self.delete),
            ("hub_put", self.put),
        ):
            monkeypatch.setattr(f"{HUB}.{name}", fn)
        return self
