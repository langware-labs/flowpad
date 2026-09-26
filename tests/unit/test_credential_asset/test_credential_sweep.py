"""The leftover-secrets sweep: clean after a delete, dirty on anything planted, and never clean when a
store could not be read. Names only — a value never appears in the result.

Every store is local or doubled: the vault and env files on disk, GCP Secret Manager on a loopback
server, the hub's script and the e2b API faked. No network.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import httpx
import pytest

from flow_sdk.builtin import credential_sweep
from flow_sdk.builtin.credential_service import delete_credential, save_credential
from flow_sdk.builtin.credential_sweep import sweep
from flow_sdk.cli.auth.secrets import write_secret
from flow_sdk.connections import Connection
from flow_sdk.ingest.testing import make_data_source
from flow_sdk.secrets import SecretStore
from tests.utils.fake_gcp_secret_manager import serving_gcp_store

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


def _manifest(name: str, *env_vars: str, **extra) -> dict:
    return {"name": name, "vars": {v: {"label": v} for v in env_vars}, "setup": "Test.", **extra}


async def _both_stores(project) -> list:
    return [
        await save_credential(
            scope="project", project_id=str(project.id), manifest=_manifest(name, var), store=store,
            values={var: "value-never-shown"},
        )
        for name, var, store in (("env-one", "SWEEP_ENV", "env"), ("vault-one", "SWEEP_VAULT", "vault"))
    ]


async def test_a_deleted_projects_credentials_leave_nothing(home, project):
    specs = await _both_stores(project)
    dirty = await sweep(project_id=str(project.id), names=["SWEEP_ENV", "SWEEP_VAULT"])
    assert {(f.store, f.name.rsplit(".", 1)[-1]) for f in dirty.found} == {("env_file", "SWEEP_ENV"), ("vault", "SWEEP_VAULT")}
    assert "value-never-shown" not in dirty.model_dump_json()

    for spec in specs:
        assert (await delete_credential(str(spec.typeid))).removed

    clean = await sweep(project_id=str(project.id), names=["SWEEP_ENV", "SWEEP_VAULT"])
    assert clean.clean and set(clean.checked) == {"vault", "env_file"}


async def test_a_planted_vault_entry_or_env_line_in_any_environment_is_found(home, project):
    write_secret(f"credential.production.project.{project.id}.PLANTED", "x", "planted")
    (Path(project.fs_storage_mount_path) / ".env.staging.local").write_text("PLANTED_LINE=x\n")
    write_secret("credential.project.some-other-project.PLANTED_LINE", "x", "not ours")

    result = await sweep(project_id=str(project.id), names=["PLANTED_LINE"])

    assert not result.clean
    assert sorted((f.store, f.name) for f in result.found) == [
        ("env_file", "PLANTED_LINE"), ("vault", f"credential.production.project.{project.id}.PLANTED")
    ]


@pytest.fixture
def google(monkeypatch):
    async def get(cls, provider):
        return Connection(provider=provider, display_name="Google", connected=True)

    async def token(self):
        return "sweep-token"

    monkeypatch.setattr(Connection, "get", classmethod(get))
    monkeypatch.setattr(Connection, "token", token)
    with serving_gcp_store(monkeypatch, tokens={"sweep-token"}) as state:
        yield state


async def _bound_source(prefix: str, *, bind: bool = True):
    store = await SecretStore.get("gcp_secret_manager", {"gcp_project": "acme", "prefix": prefix})
    if bind:
        await store.set_connection(Connection(provider="google", display_name="Google", connected=True))
    row = make_data_source("sweep-test")
    row.secret_store = store.ref
    await row.save()


async def test_a_remote_store_a_source_binds_is_read(home, google):
    await _bound_source("app-")
    google.put("acme", "app-REMOTE_KEY", "x")

    result = await sweep(names=["REMOTE_KEY"])

    assert [(f.store, f.where, f.name) for f in result.found] == [("gcp_secret_manager", "acme/app-", "REMOTE_KEY")]


async def test_a_store_that_cannot_be_read_is_unchecked_not_clean(home, google):
    await _bound_source("other-", bind=False)

    result = await sweep(names=["REMOTE_KEY"])

    assert not result.clean and result.found == []
    assert [(u.store, "StoreNeedsConnection" in u.error) for u in result.unchecked] == [("gcp_secret_manager", True)]


async def test_the_hub_leg_reports_what_its_script_finds_and_an_unreadable_hub(home, tmp_path, monkeypatch):
    def script(answer: dict) -> list[str]:
        return [sys.executable, "-c", f"print({json.dumps(json.dumps(answer))})"]

    monkeypatch.setattr(credential_sweep, "HUB_LEFTOVERS", script({"found": ["agent_KEY_a1"]}))
    found = await sweep(agent_id="a1", hub_root=tmp_path)
    assert [(f.store, f.name) for f in found.found] == [("hub", "agent_KEY_a1")]

    monkeypatch.setattr(credential_sweep, "HUB_LEFTOVERS", script({"error": "RuntimeError: unreadable"}))
    unread = await sweep(agent_id="a1", hub_root=tmp_path)
    assert not unread.clean and unread.unchecked[0].error == "RuntimeError: unreadable"


async def test_the_e2b_leg_finds_the_agents_live_boxes_and_needs_its_key(home, monkeypatch):
    monkeypatch.delenv("E2B_API_KEY", raising=False)
    assert (await sweep(agent_id="a1", e2b=True)).unchecked[0].error == "E2B_API_KEY is not set"

    boxes = [{"sandboxID": "sbx-mine", "metadata": {"source": "agent-a1"}}, {"sandboxID": "sbx-other", "metadata": {}}]
    real = httpx.AsyncClient

    def client(*args, **kwargs):
        assert kwargs["headers"]["X-API-KEY"] == "e2b-test-key"
        return real(*args, transport=httpx.MockTransport(lambda request: httpx.Response(200, json=boxes)), **kwargs)

    monkeypatch.setenv("E2B_API_KEY", "e2b-test-key")
    monkeypatch.setattr(httpx, "AsyncClient", client)
    result = await sweep(agent_id="a1", e2b=True)
    assert [(f.store, f.name) for f in result.found] == [("e2b", "sbx-mine")]
    assert "e2b-test-key" not in result.model_dump_json()


async def test_flow_credentials_audit_exits_by_what_it_found(home, project, run_flow):
    argv = ("credentials", "audit", "--project", str(project.id), "--name", "AUDIT_KEY")

    clean = await run_flow(*argv)
    assert clean.exit_code == 0 and json.loads(clean.stdout)["clean"] is True

    (Path(project.fs_storage_mount_path) / ".env.local").write_text("AUDIT_KEY=x\n")
    dirty = await run_flow(*argv)
    assert dirty.exit_code == 1 and "AUDIT_KEY=x" not in dirty.output
