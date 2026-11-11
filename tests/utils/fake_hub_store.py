"""An in-memory hub for a cloud deployment's secrets: its env-var routes, ``plan_deployment`` and
``deploy``. Records every call (method, action, sub_path, payload KEYS) so a test can prove no value
rode a log-able place; holds values per deployment id like the hub's SOD.

``plan_deployment`` keeps the hub's rule (flowpad-hub#1250): a plan that names no ``deployment_id`` makes a
NEW placement; one that names a row plans that row again, and a row the hub does not hold is refused (404)."""

from __future__ import annotations

import uuid
from types import SimpleNamespace

from flow_sdk.cloud_client.hub_proxy import HubProxy
from flow_sdk.cloud_client.shared.errors import HubError


class FakeHubStore:
    def __init__(self):
        self.values: dict[str, dict[str, str]] = {}
        self.calls: list[tuple] = []
        self.deploys: list[dict] = []
        #: The placement each deploy named, in order: a deploy is for the row its plan made.
        self.deploy_ids: list[str | None] = []
        #: The main agent each deploy named (``agent-<id>``), in order.
        self.main_agents: list[str | None] = []
        self.authorized: dict[str, list[str]] = {}
        self.webhooks: dict[str, list[str]] = {}
        self.help_desks: dict[str, list[str] | None] = {}
        #: ``deployment/<id>/funding`` answers by deployment id; none = the hub cannot say.
        self.funding: dict[str, dict] = {}
        #: Every placement planned, by id, in the order made.
        self.rows: dict[str, dict] = {}

    def planned(self, project_typeid: str, environment: str) -> list[dict]:
        """The placements planned for *project_typeid* in *environment*, oldest first."""
        return [
            row
            for row in self.rows.values()
            if row["parent_type_id"] == project_typeid and row["environment"] == environment
        ]

    def _plan(self, project_typeid: str, payload: dict) -> dict:
        named = payload.get("deployment_id")
        if named:
            row = self.rows.get(named)
            if row is None or row["parent_type_id"] != project_typeid:
                raise HubError(404, f"no placement {named} for {project_typeid}")
        else:
            environment = payload["environment"]
            row = {
                "id": str(uuid.uuid4()),
                "name": f"project ({environment})",
                "parent_type_id": project_typeid,
                "main_agent_id": payload.get("main_agent_id"),
                "environment": environment,
                "target": {"provider": payload.get("provider") or "e2b", "scope": project_typeid},
                "llm_endpoint_typeid": "",
            }
            self.rows[row["id"]] = row
        # Its own token allocation: an object gives it a sub-endpoint, ``None`` releases it, absent leaves it.
        if "token_allocation" in payload:
            row["llm_endpoint_typeid"] = f"llm_endpoint-{uuid.uuid4()}" if payload["token_allocation"] else ""
        return dict(row)

    @staticmethod
    def webhook_url(name: str) -> str:
        return f"https://hub.test/api/v1/webhook/{uuid.uuid5(uuid.NAMESPACE_URL, name)}"

    async def get(self, etype, eid=None, action=None, sub_path=None, **_):
        self.calls.append(("GET", str(etype), eid, action, sub_path))
        if action == "env-var":
            return [{"name": n, "var_type": "api_key", "visible_value": "****"} for n in self.values.get(eid, {})]
        if action == "authorize":
            return [{"provider": p, "permissions": []} for p in self.authorized.get(eid, [])]
        if action == "funding":
            return self.funding.get(eid)
        if action == "secrets":
            return {
                "secrets": [{"name": n} for n in self.values.get(eid, {})],
                "authorizations": [{"provider": p} for p in self.authorized.get(eid, [])],
            }
        return None

    async def post(self, etype, payload, eid=None, action=None, sub_path=None, **_):
        self.calls.append(("POST", str(etype), eid, action, sorted(payload)))
        if action == "env-var":
            self.values.setdefault(eid, {})[payload["name"]] = payload["value"]
            return {"name": payload["name"]}
        if action == "authorize":
            self.authorized.setdefault(eid, []).append(payload["provider"])
            return {"provider": payload["provider"]}
        if action == "plan_deployment":
            deployment = self._plan(f"project-{eid}", payload)
            # The hub keeps each asked-for webhook and stores its URL as the driver's variable.
            self.webhooks[deployment["id"]] = [hook["name"] for hook in payload.get("webhooks") or []]
            self.help_desks[deployment["id"]] = payload.get("help_desks")
            for hook in payload.get("webhooks") or []:
                self.values.setdefault(deployment["id"], {})[hook["var"]] = self.webhook_url(hook["name"])
            return {"deployment": deployment}
        return None

    async def put(self, etype, eid, payload, action=None, sub_path=None, **_):
        self.calls.append(("PUT", str(etype), eid, action, sub_path, sorted(payload)))
        self.values.setdefault(eid, {})[sub_path] = payload["value"]
        return {"name": sub_path}

    async def delete(self, etype, eid, action=None, sub_path=None, **_):
        self.calls.append(("DELETE", str(etype), eid, action, sub_path))
        if action == "authorize":
            self.authorized[eid] = [p for p in self.authorized.get(eid, []) if p != sub_path]
            return {"revoked": [sub_path]}
        self.values.get(eid, {}).pop(sub_path, None)
        return {}

    async def call(self, method, etype, eid=None, action=None, sub_path=None, *, payload=None, **_):
        """``HubProxy.call`` / ``try_call``, routed to the verb doubles above."""
        method = method.upper()
        if method == "GET":
            return await self.get(etype, eid, action, sub_path)
        if method == "POST":
            return await self.post(etype, payload, eid, action, sub_path)
        if method == "PUT":
            return await self.put(etype, eid, payload, action, sub_path)
        assert method == "DELETE", method
        return await self.delete(etype, eid, action, sub_path)

    async def deploy(
        self, entity, environment=None, *, provider=None, require=None, deployment_id=None, machine_size=None, **extra
    ):
        self.deploys.append({"environment": environment, "provider": provider, "require": list(require or [])})
        self.main_agents.append(extra.get("main_agent_id"))
        self.deploy_ids.append(deployment_id)
        return {"deployment": {}, "secrets": {"placed": sorted(require or []), "failed": {}}}


def install(monkeypatch) -> FakeHubStore:
    fake = FakeHubStore()
    monkeypatch.setattr(HubProxy, "call", staticmethod(fake.call))
    monkeypatch.setattr(HubProxy, "try_call", staticmethod(fake.call))
    monkeypatch.setattr("flow_sdk.builtin.cloud_deploy.deploy_entity_to_cloud", fake.deploy)
    return fake


__all__ = ["FakeHubStore", "SimpleNamespace", "install"]
