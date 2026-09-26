"""An in-memory hub for a cloud deployment's secrets: its env-var routes, ``plan_deployment`` and
``deploy``. Records every call (method, action, sub_path, payload KEYS) so a test can prove no value
rode a log-able place; holds values per deployment id like the hub's SOD."""

from __future__ import annotations

import uuid
from types import SimpleNamespace


class FakeHubStore:
    def __init__(self):
        self.values: dict[str, dict[str, str]] = {}
        self.calls: list[tuple] = []
        self.deploys: list[dict] = []
        self.authorized: dict[str, list[str]] = {}

    def deployment(self, agent_typeid: str, environment: str) -> dict:
        return {"id": self._ids.setdefault((agent_typeid, environment), str(uuid.uuid4())), "name": f"agent ({environment})",
                "kind": "runtime.agent", "parent_type_id": agent_typeid, "environment": environment,
                "target": {"provider": "e2b", "scope": agent_typeid}}

    _ids: dict = {}

    async def get(self, etype, eid=None, action=None, sub_path=None, **_):
        self.calls.append(("GET", str(etype), eid, action, sub_path))
        if action == "env-var":
            return [{"name": n, "var_type": "api_key", "visible_value": "****"} for n in self.values.get(eid, {})]
        if action == "authorize":
            return [{"provider": p, "permissions": []} for p in self.authorized.get(eid, [])]
        if action == "secrets":
            return {"secrets": [{"name": n} for n in self.values.get(eid, {})],
                    "authorizations": [{"provider": p} for p in self.authorized.get(eid, [])]}
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
            return {"deployment": self.deployment(f"agent-{eid}", payload["environment"])}
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

    async def deploy(self, entity, environment=None, *, require=None):
        self.deploys.append({"environment": environment, "require": list(require or [])})
        return {"deployment": {}, "secrets": {"placed": sorted(require or []), "failed": {}}}


def install(monkeypatch) -> FakeHubStore:
    fake = FakeHubStore()
    for name in ("get", "post", "put", "delete"):
        monkeypatch.setattr(f"flow_sdk.cloud_client.transport.hub_http.hub_{name}", getattr(fake, name))
    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_get_or_raise", fake.get)
    monkeypatch.setattr("flow_sdk.builtin.cloud_deploy.deploy_entity_to_cloud", fake.deploy)
    return fake


__all__ = ["FakeHubStore", "SimpleNamespace", "install"]
