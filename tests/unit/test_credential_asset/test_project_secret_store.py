"""A project's secret vaults — the ONE way a value travels between people.

``secret_vaults`` in ``project_manifest.json`` names them ({name: {manager, config}}, never a value).
A sharer PUBLISHES their local value into a vault under each variable's ``secret_ref {vault, key}``;
the spec travels with the project; a receiver FETCHES into their own ``.env.local``. These tests
stand a fake ``team`` manager in for a real one: its vault is an ``env_file`` store outside the
project.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from dotenv import dotenv_values

from flow_sdk.assets.project_manifest import ManifestError, manifest_path, read_secret_vaults, set_secret_vault
from flow_sdk.builtin.credential_service import CredentialError, fetch, publish, save_credential, set_credential_values
from flow_sdk.builtin.credential_store import UnknownVault, project_vault, project_vaults
from flow_sdk.schema.data_spec.secret_vault_spec import SecretRefSpec, SecretVaultSpec

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


@pytest.fixture(autouse=True)
def team_manager(monkeypatch):
    """A fake secret manager ``team``: a vault is an env file named by its config ``path``."""
    from flow_sdk.secrets import managers
    from flow_sdk.secrets.env_file import EnvFileStore
    from flow_sdk.secrets.store import SecretStore

    real = managers.get_manager

    def get_manager(name):
        return {"name": "team"} if name == "team" else real(name)

    def store_for(vault: SecretVaultSpec) -> EnvFileStore:
        assert vault.manager == "team"
        return SecretStore.from_ref({"type": "env_file", "config": {"env_file_path": vault.config["path"]}})

    monkeypatch.setattr(managers, "get_manager", get_manager)
    monkeypatch.setattr(managers, "store_for", store_for)


@pytest.fixture
def mount(project) -> Path:
    root = Path(project.fs_storage_mount_path)
    (root / ".gitignore").write_text(".env.local\n")
    return root


@pytest.fixture
def team_file(tmp_path, mount) -> Path:
    """The team's vault: a file no clone of the project contains."""
    path = tmp_path / "team-secrets.env"
    set_secret_vault(mount, "team", {"manager": "team", "config": {"path": str(path)}})
    return path


async def _bright_data(project, **var):
    return await save_credential(
        manifest={"name": "bright_data", "vars": {"BRIGHT_DATA_API": {"required": "OPTIONAL", **var}}, "setup": "From the team."},
        scope="project", project_id=str(project.id),
    )


# ── the declaration ─────────────────────────────────────────────────────────


async def test_no_vault_writes_no_key(home, project, mount):
    set_secret_vault(mount, "team", None)
    assert not manifest_path(mount).exists(), "removing never creates a manifest"
    assert read_secret_vaults(mount) == {}


async def test_vaults_travel_in_the_manifest_by_name(home, project, mount, team_file, tmp_path):
    other = tmp_path / "ops.env"
    set_secret_vault(mount, "ops", {"manager": "team", "config": {"path": str(other)}})
    document = json.loads(manifest_path(mount).read_text())
    assert document["secret_vaults"] == {
        "team": {"manager": "team", "config": {"path": str(team_file)}},
        "ops": {"manager": "team", "config": {"path": str(other)}},
    }
    assert set(project_vaults(project)) == {"team", "ops"}

    set_secret_vault(mount, "ops", None)
    set_secret_vault(mount, "team", None)
    assert "secret_vaults" not in json.loads(manifest_path(mount).read_text()), "empty is dropped on dump"


async def test_an_unknown_manager_is_refused_and_nothing_is_written(home, project, mount):
    with pytest.raises(ManifestError):
        set_secret_vault(mount, "x", {"manager": "no-such-manager"})
    with pytest.raises(ManifestError):
        set_secret_vault(mount, "", {"manager": "team", "config": {"path": "/tmp/x"}})
    assert not manifest_path(mount).exists()


async def test_an_undeclared_vault_raises_unknown_vault(home, project, mount, team_file):
    assert project_vault(project, "team") is not None
    with pytest.raises(UnknownVault) as refused:
        project_vault(project, "nope")
    assert refused.value.code == "unknown_vault"


async def test_secret_ref_is_a_vault_and_key():
    from flow_sdk.schema.data_spec.credential_spec import CredentialVarSpec

    assert CredentialVarSpec().store_key("A") == "A"
    var = CredentialVarSpec(secret_ref={"vault": "team", "key": "GTM_A"})
    assert var.secret_ref == SecretRefSpec(vault="team", key="GTM_A") and var.store_key("A") == "GTM_A"


# ── values between people ───────────────────────────────────────────────────


async def test_publish_then_fetch_moves_the_value_and_answers_names_only(home, project, mount, team_file):
    spec = await _bright_data(project)
    await set_credential_values(str(spec.typeid), {"BRIGHT_DATA_API": "bd-secret"}, None)

    published = await publish("bright_data", str(project.id), "team")
    assert published == {"published": ["BRIGHT_DATA_API"], "not_here": [], "vault": "team"}
    assert "bd-secret" not in json.dumps(published), "names only"
    assert dotenv_values(team_file) == {"BRIGHT_DATA_API": "bd-secret"}

    (mount / ".env.local").write_text("")  # the receiver's clone: no local value
    fetched = await fetch("bright_data", str(project.id))
    assert fetched == {"fetched": ["BRIGHT_DATA_API"], "missing": [], "denied": [], "vaults": ["team"]}
    assert dotenv_values(mount / ".env.local")["BRIGHT_DATA_API"] == "bd-secret"


async def test_the_secret_ref_names_the_key_in_the_vault(home, project, mount, team_file):
    spec = await _bright_data(project, secret_ref={"vault": "team", "key": "GTM_BRIGHT_DATA"})
    await set_credential_values(str(spec.typeid), {"BRIGHT_DATA_API": "bd-secret"}, None)

    await publish("bright_data", str(project.id), "team")
    assert dotenv_values(team_file) == {"GTM_BRIGHT_DATA": "bd-secret"}

    (mount / ".env.local").write_text("")
    await fetch("bright_data", str(project.id))
    assert dotenv_values(mount / ".env.local")["BRIGHT_DATA_API"] == "bd-secret", "fetched under its own name"


async def test_a_value_the_vault_lacks_is_reported_missing(home, project, mount, team_file):
    await _bright_data(project, secret_ref={"vault": "team", "key": "BRIGHT_DATA_API"})
    fetched = await fetch("bright_data", str(project.id))
    assert fetched["fetched"] == [] and fetched["missing"] == ["BRIGHT_DATA_API"]


async def test_publish_without_a_local_value_reports_it_and_writes_nothing(home, project, mount, team_file):
    await _bright_data(project)
    published = await publish("bright_data", str(project.id), "team")
    assert published["published"] == [] and published["not_here"] == ["BRIGHT_DATA_API"]
    assert not team_file.exists() or dotenv_values(team_file) == {}


async def test_without_a_vault_both_refuse_with_a_code(home, project, mount):
    await _bright_data(project)
    with pytest.raises(CredentialError) as refused:
        await publish("bright_data", str(project.id), "team")
    assert refused.value.code == "no_vault"
    with pytest.raises(CredentialError) as refused:
        await fetch("bright_data", str(project.id))
    assert refused.value.code == "no_vault"


async def test_publish_to_an_undeclared_vault_is_refused(home, project, mount, team_file):
    await _bright_data(project)
    with pytest.raises(CredentialError) as refused:
        await publish("bright_data", str(project.id), "nope")
    assert refused.value.code == "unknown_vault"


# ── the per-type handlers ───────────────────────────────────────────────────


async def test_pre_share_asks_for_a_secret_manager_only_when_the_project_has_none(home, project, mount, tmp_path):
    from flow_sdk.app.actions.pre_share_action import pre_share_of

    spec = await _bright_data(project)
    needed = await pre_share_of("credential", str(spec.id))
    assert needed["needed"] is True and needed["kind"] == "secret_vault"
    assert needed["project_id"] == str(project.id) and needed["vaults"] == []

    set_secret_vault(mount, "team", {"manager": "team", "config": {"path": str(tmp_path / "team.env")}})
    await set_credential_values(str(spec.typeid), {"BRIGHT_DATA_API": "bd-secret"}, None)
    await publish("bright_data", str(project.id), "team")
    assert await pre_share_of("credential", str(spec.id)) == {"needed": False}


async def test_pre_share_is_not_needed_for_a_type_without_a_handler(home, project):
    from flow_sdk.app.actions.pre_share_action import pre_share_of

    assert await pre_share_of("project", str(project.id)) == {"needed": False}


async def test_a_received_credential_respects_auto_run_off(home, project, mount, monkeypatch):
    from types import SimpleNamespace

    from flow_sdk.app.actions import message_attachment_action as mod
    from flow_sdk.builtin.credential import Credential

    spec = await _bright_data(project)
    called = {}

    async def handler(self, *, project_id=None, workdir=None):
        called["project_id"] = project_id
        return {"type": "credential", "id": str(self.id)}

    monkeypatch.setattr(Credential, "setup_on_receive", handler)

    async def no_file(_ma):
        return None

    monkeypatch.setattr(mod, "_shared_file_target", no_file)
    ma = SimpleNamespace(asset_type="credential", asset_id=str(spec.id), name="bright_data", project_id=str(project.id))
    await mod._setup_after_install(ma, None, auto_run=False)
    assert called == {}, "auto_run=False is never bypassed by a receive handler"


# ── setup tree, pre-share, receive ─────────────────────────────────────────────


async def test_pre_share_asks_while_a_value_is_not_published_to_a_declared_vault(home, project, mount, team_file):
    from flow_sdk.app.actions.pre_share_action import pre_share_of

    spec = await _bright_data(project)
    needed = await pre_share_of("credential", str(spec.id))
    assert needed["needed"] is True and needed["vaults"] == ["team"], "a vault exists, but nothing points into it"


async def test_a_credential_in_a_vault_sets_the_vault_up_below_it_then_fetches(home, project, mount, team_file, monkeypatch):
    from flow_sdk.core.setup.derive import ProjectTree
    from flow_sdk.secrets import managers

    commands = {"install": "brew install teamcli", "login": "teamcli signin", "check": "teamcli vault get {vault}"}
    monkeypatch.setattr(managers, "cli_command", lambda _m, op, _os, **v: commands[op].format(**v))
    await save_credential(
        manifest={"name": "bright_data", "vars": {"BRIGHT_DATA_API": {
            "required": "MUST", "secret_ref": {"vault": "team", "key": "BRIGHT_DATA_API"}}}, "setup": "From the team."},
        scope="project", project_id=str(project.id),
    )
    tree = await ProjectTree(project).load()

    cred = tree.nodes["credential:bright_data"]
    assert cred.children == ("vault:team",), "a credential waits on the vault it fetches from"
    vault = tree.nodes["vault:team"]
    assert [s.id for s in vault.run.steps] == ["install", "login", "check"]
    install = tree.ops["vault:team:install"]
    assert install.completion_check.command_for("linux") == "command -v teamcli >/dev/null 2>&1"
    assert tree.ops["vault:team:login"].completion_check.command_for("linux") == "teamcli vault get team"
    assert "secrets check team --project" in tree.ops["vault:team:check"].exe_data.command_for("linux")
    assert cred.run.steps[0].id == "fetch-bright_data"
    assert "secrets fetch bright_data --project" in tree.ops["fetch-bright_data"].exe_data.command_for("linux")


async def test_a_received_credential_with_no_vault_opens_with_a_no_vault_error(home, project, mount):
    spec = await _bright_data(project)
    shown = await spec.setup_on_receive(project_id=str(project.id))
    assert shown["id"] == str(spec.id) and shown["receive_error"]["code"] == "no_vault"
