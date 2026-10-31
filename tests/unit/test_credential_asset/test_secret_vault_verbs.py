"""The vault verbs (``credential_service.publish/fetch/vault_check/grant/set_vault``) over a fake
in-memory secret manager ``memvault``: the store is a ``SecretStore`` registered under that name,
its vaults are dicts keyed by the config's ``vault``. Names travel, values never print."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterable, Mapping

import pytest
from pydantic import SecretStr

from flow_sdk.builtin import credential_service as svc
from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.secrets import StoreAccessDenied
from flow_sdk.secrets.store import SecretStore, plain_values, register_store

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

VAULTS: dict[str, dict[str, str]] = {}
DENIED: set[str] = set()
GRANTS: list[tuple[str, str]] = []
READY: set[str] = set()


class _MemConfig(DataSpec):
    vault: str


@register_store
class MemVaultStore(SecretStore):
    type_name = "memvault"
    config_spec = _MemConfig

    @property
    def _name(self) -> str:
        return self.config.vault

    def _check(self) -> dict[str, str]:
        if self._name in DENIED:
            raise StoreAccessDenied("memvault", "memvault", [self._name])
        return VAULTS.setdefault(self._name, {})

    async def load(self, names: Iterable[str]) -> dict[str, SecretStr]:
        held = self._check()
        return {n: SecretStr(held[n]) for n in names if n in held}

    async def save(self, values: Mapping[str, Any], *, description: str = "") -> None:
        self._check().update({k: v for k, v in plain_values(values).items() if v})


@pytest.fixture(autouse=True)
def memvault(monkeypatch):
    from flow_sdk.secrets import managers

    VAULTS.clear(), DENIED.clear(), GRANTS.clear(), READY.clear()
    real_get, real_list = managers.get_manager, managers.list_managers
    fake = managers.SecretManagerSpec.model_validate({"name": "memvault", "title": "Mem vault", "check": "true", "grant": "true"})

    def store_for(vault):
        return SecretStore.from_ref({"type": "memvault", "config": {"vault": vault.config["vault"]}})

    async def run_check(vault):
        return vault.config["vault"] in READY

    async def run_grant(vault, email):
        GRANTS.append((vault.config["vault"], email))

    monkeypatch.setattr(managers, "get_manager", lambda n: fake if n == "memvault" else real_get(n))
    monkeypatch.setattr(managers, "list_managers", lambda: [*real_list(), fake])
    monkeypatch.setattr(managers, "store_for", store_for)
    monkeypatch.setattr(managers, "run_check", run_check)
    monkeypatch.setattr(managers, "run_grant", run_grant)


@pytest.fixture
def pid(project) -> str:
    (Path(project.fs_storage_mount_path) / ".gitignore").write_text(".env.local\n")
    return str(project.id)


async def _vault(pid: str, name: str) -> None:
    await svc.set_vault(pid, name, {"manager": "memvault", "config": {"vault": f"v-{name}"}})


async def _cred(pid: str, values: dict[str, str]):
    spec = await svc.save_credential(
        manifest={"name": "acme", "vars": {v: {"required": "OPTIONAL"} for v in ("ACME_KEY", "ACME_TOKEN")}, "setup": "ask"},
        scope="project", project_id=pid,
    )
    if values:
        await svc.set_credential_values(str(spec.typeid), values, None)
    return spec


async def test_vaults_add_list_remove(home, project, pid):
    await _vault(pid, "team")
    listed = await svc.list_vaults(pid)
    assert listed == {"vaults": {"team": {"manager": "memvault", "config": {"vault": "v-team"}}}}
    assert (await svc.set_vault(pid, "team", None)) == {"vaults": {}}


async def test_an_unknown_manager_is_refused(home, project, pid):
    with pytest.raises(svc.CredentialError):
        await svc.set_vault(pid, "x", {"manager": "no-such-manager"})


async def test_managers_lists_the_test_manager():
    assert "memvault" in {m["name"] for m in svc.list_managers()}


async def test_publish_writes_refs_and_fetch_reads_them_back(home, project, pid):
    await _vault(pid, "team")
    await _cred(pid, {"ACME_KEY": "k-secret", "ACME_TOKEN": "t-secret"})
    published = await svc.publish("acme", pid, "team")
    assert published == {"published": ["ACME_KEY", "ACME_TOKEN"], "not_here": [], "vault": "team"}
    assert "secret" not in json.dumps(published)
    assert VAULTS["v-team"] == {"ACME_KEY": "k-secret", "ACME_TOKEN": "t-secret"}
    spec = await svc.credential_named("acme", project)
    assert {v: spec.vars[v].secret_ref.model_dump() for v in spec.vars} == {
        "ACME_KEY": {"vault": "team", "key": "ACME_KEY"}, "ACME_TOKEN": {"vault": "team", "key": "ACME_TOKEN"},
    }
    fetched = await svc.fetch("acme", pid)
    assert fetched == {"fetched": ["ACME_KEY", "ACME_TOKEN"], "missing": [], "denied": [], "vaults": ["team"]}


async def test_an_existing_ref_keeps_its_vault(home, project, pid):
    await _vault(pid, "team"), await _vault(pid, "ops")
    await _cred(pid, {"ACME_KEY": "k1"})
    await svc.publish("acme", pid, "team")
    await svc.set_credential_values(str((await svc.credential_named("acme", project)).typeid), {"ACME_TOKEN": "t1"}, None)
    await svc.publish("acme", pid, "ops")
    assert VAULTS["v-team"]["ACME_KEY"] == "k1"
    assert VAULTS["v-team"].get("ACME_TOKEN") == "t1", "ACME_TOKEN got its ref to team on the first publish"
    assert "v-ops" not in VAULTS or not VAULTS["v-ops"]


async def test_a_denied_vault_is_named_and_the_rest_still_fetch(home, project, pid):
    await _vault(pid, "team")
    await _cred(pid, {"ACME_KEY": "k"})
    await svc.publish("acme", pid, "team")
    DENIED.add("v-team")
    fetched = await svc.fetch("acme", pid)
    assert fetched["denied"] == ["team"] and fetched["fetched"] == []


async def test_codes_no_vault_and_unknown_vault(home, project, pid):
    await _cred(pid, {"ACME_KEY": "k"})
    with pytest.raises(svc.CredentialError) as e:
        await svc.publish("acme", pid, "team")
    assert e.value.code == "no_vault"
    await _vault(pid, "team")
    with pytest.raises(svc.CredentialError) as e:
        await svc.publish("acme", pid, "nope")
    assert e.value.code == "unknown_vault"
    with pytest.raises(svc.CredentialError) as e:
        await svc.fetch("acme", pid)
    assert e.value.code == "no_vault", "no ref yet: nothing to fetch from"


async def test_a_denied_publish_is_code_denied(home, project, pid):
    await _vault(pid, "team")
    await _cred(pid, {"ACME_KEY": "k"})
    DENIED.add("v-team")
    with pytest.raises(svc.CredentialError) as e:
        await svc.publish("acme", pid, "team")
    assert e.value.code == "denied"
    spec = await svc.credential_named("acme", project)
    assert spec.vars["ACME_KEY"].secret_ref is None, "a refused publish records no ref"


async def test_check_and_grant(home, project, pid):
    await _vault(pid, "team")
    assert (await svc.vault_check(pid, "team"))["ready"] is False
    READY.add("v-team")
    assert await svc.vault_check(pid, "team") == {"vault": "team", "ready": True, "reason": ""}
    assert await svc.grant(pid, "team", "bob@x.test") == {"vault": "team", "email": "bob@x.test"}
    assert GRANTS == [("v-team", "bob@x.test")]
