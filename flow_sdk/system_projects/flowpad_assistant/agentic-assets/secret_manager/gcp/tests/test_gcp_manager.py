"""The ``gcp`` manager: its store is the SDK's Secret Manager store under the manager's own config
names, against the loopback Secret Manager v1; its grant is the Secret Accessor binding."""
from __future__ import annotations

import os
import stat

import pytest

from flow_sdk.secrets import StoreNeedsConnection
from flow_sdk.secrets.gcp_secret_manager import GcpSecretManagerStore
from flow_sdk.secrets.managers import cli_command, get_manager, run_check, run_grant, store_for
from tests.utils.fake_gcp_secret_manager import serving_gcp_store

pytestmark = [pytest.mark.timeout(10)]  # do not increase timeout without approval

VAULT = {"manager": "gcp", "config": {"project": "acme-prod", "prefix": "app-"}}


def test_commands_per_os():
    assert [f.name for f in get_manager("gcp").config_fields if f.required] == ["project"]
    assert cli_command("gcp", "install", "win32") == "winget install Google.CloudSDK"
    assert "google-cloud-sdk" in cli_command("gcp", "install", "darwin")
    assert cli_command("gcp", "login", "darwin") == "gcloud auth login"
    assert cli_command("gcp", "check", project="acme-prod") == "gcloud secrets list --project acme-prod --limit 1"


@pytest.mark.asyncio
async def test_the_vault_store_round_trips_through_secret_manager(monkeypatch):
    with serving_gcp_store(monkeypatch, tokens={"tok"}) as gcp:
        store = store_for(VAULT)
        assert isinstance(store, GcpSecretManagerStore) and store.type_name == "gcp"
        assert store.where == "GCP project acme-prod · app-*"
        with pytest.raises(StoreNeedsConnection):
            await store.load(["API_KEY"])

        class Conn:
            provider = "google"

            async def token(self):
                return "tok"

        store.connection, store._held = "google", Conn()
        await store.save({"API_KEY": "v1"})
        assert {k: v.get_secret_value() for k, v in (await store.load(["API_KEY"])).items()} == {"API_KEY": "v1"}
        assert await store.names() == ["API_KEY"]
        assert ("acme-prod", "app-API_KEY") in gcp.secrets


@pytest.mark.asyncio
async def test_grant_binds_the_secret_accessor_role(tmp_path, monkeypatch):
    log = tmp_path / "argv"
    script = tmp_path / "gcloud"
    script.write_text(f'#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "{log}"\n')
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PATH", f"{tmp_path}{os.pathsep}{os.environ.get('PATH', '')}")

    assert await run_check(VAULT) is True
    await run_grant(VAULT, "bob@acme.com")
    assert log.read_text().splitlines() == [
        "projects", "add-iam-policy-binding", "acme-prod", "--member", "user:bob@acme.com",
        "--role", "roles/secretmanager.secretAccessor",
    ]
