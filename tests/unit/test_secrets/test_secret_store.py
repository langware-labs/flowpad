"""SecretStore: a type plus its config, keyed by variable name; load, save, names, validate, forget."""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from pydantic import ValidationError

from flow_sdk.builtin.env_local_store import EnvLocalNotWritable
from flow_sdk.secrets import (
    EnvFileStore,
    MissingSecrets,
    NoCurrentProject,
    SecretStore,
    SecretStoreRef,
    UnknownSecretStore,
    VaultNotEnabled,
    VaultStore,
    load_all,
)
from tests.unit.test_secrets.conftest import git_init

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


async def test_the_default_store_is_the_current_projects_env_local(in_project):
    store = await SecretStore.get()

    assert isinstance(store, EnvFileStore)
    assert store.path == Path(in_project.fs_storage_mount_path) / ".env.local"


async def test_outside_every_project_there_is_no_default_store(folder_db, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    with pytest.raises(NoCurrentProject):
        await SecretStore.get()


async def test_a_store_is_asked_for_by_a_registered_type_and_a_strict_config(tmp_path):
    with pytest.raises(UnknownSecretStore, match="env_file"):
        await SecretStore.get("s3", {})
    with pytest.raises(ValidationError):
        await SecretStore.get("vault", {"prefx": "credential.user."})
    with pytest.raises(TypeError):
        await SecretStore.get(config={"prefix": "x"})
    store = await SecretStore.get("env_file", {"env_file_path": str(tmp_path / ".env.local")})
    assert isinstance(store, EnvFileStore) and store.ref.type == "env_file"


async def test_a_ref_round_trips_and_names_no_value(tmp_path):
    store = await SecretStore.get("vault", {"prefix": "credential.user."})

    again = SecretStore.from_ref(store.ref.model_dump(mode="json"))

    assert isinstance(again, VaultStore) and again.ref == store.ref
    assert store.ref.key == SecretStoreRef(type="vault", config={"prefix": "credential.user."}).key
    with pytest.raises(ValidationError):
        SecretStoreRef(type="vault", config={}, value="x")


async def test_an_env_file_store_saves_loads_lists_validates_and_keeps_lines(tmp_path):
    git_init(tmp_path)
    store = await SecretStore.get("env_file", {"env_file_path": str(tmp_path / ".env.local")})

    await store.save({"DATABASE_URL": "postgres://localhost/dev", "EMPTY": ""})

    assert ".env.local" in (tmp_path / ".gitignore").read_text()
    values = await store.load(["DATABASE_URL", "SENTRY_DSN"])
    assert list(values) == ["DATABASE_URL"]
    assert values["DATABASE_URL"].get_secret_value() == "postgres://localhost/dev"
    assert "postgres" not in repr(values)
    assert await store.names() == ["DATABASE_URL"]
    await store.validate_keys(["DATABASE_URL"])
    with pytest.raises(MissingSecrets) as missing:
        await store.validate_keys(["DATABASE_URL", "SENTRY_DSN"])
    assert missing.value.missing == ["SENTRY_DSN"]
    assert "postgres" not in str(missing.value)
    assert await store.forget(["DATABASE_URL"]) == ([], ["DATABASE_URL"])
    assert "DATABASE_URL" in await store.load(["DATABASE_URL"])


async def test_an_env_file_store_never_writes_a_committable_file(tmp_path):
    git_init(tmp_path)
    tracked = tmp_path / ".env.production.local"
    tracked.write_text("")
    subprocess.run(["git", "add", "-f", tracked.name], cwd=tmp_path, check=True)
    store = await SecretStore.get("env_file", {"env_file_path": str(tracked)})

    with pytest.raises(EnvLocalNotWritable) as refused:
        await store.save({"DATABASE_URL": "postgres://prod"})

    assert refused.value.code == "tracked"
    assert tracked.read_text() == ""
    with pytest.raises(ValueError, match="not a variable name"):
        await store.save({"not a name": "x"})


async def test_a_store_whose_scope_has_no_folder_holds_nothing_and_refuses_a_write():
    store = await SecretStore.get("env_file", {})

    assert await store.load(["A_KEY"]) == {}
    assert await store.names() == []
    with pytest.raises(EnvLocalNotWritable):
        await store.save({"A_KEY": "a"})


async def test_vault_stores_are_isolated_by_prefix(sod_env):
    user = await SecretStore.get("vault", {"prefix": "credential.user."})
    project = await SecretStore.get("vault", {"prefix": "credential.project.p1."})

    await user.save({"TOKEN": "user-token"})
    await project.save({"TOKEN": "project-token"})

    assert (await user.load(["TOKEN"]))["TOKEN"].get_secret_value() == "user-token"
    assert (await project.load(["TOKEN"]))["TOKEN"].get_secret_value() == "project-token"
    assert await project.names() == ["TOKEN"]
    assert await user.forget(["TOKEN", "NEVER_SAVED"]) == (["TOKEN"], [])
    assert await user.load(["TOKEN"]) == {}
    assert "TOKEN" in await project.load(["TOKEN"])


async def test_a_named_entry_overrides_the_prefix(sod_env):
    from flow_sdk.cli.auth.secrets import read_secret

    store = await SecretStore.get("vault", {"entries": {"OPENAI_API_KEY": "lm_api.openai"}})

    await store.save({"OPENAI_API_KEY": "sk-test"})

    assert read_secret("lm_api.openai") == "sk-test"
    assert await store.names() == ["OPENAI_API_KEY"]


async def test_a_disabled_vault_refuses_a_value(sod_env, monkeypatch):
    monkeypatch.setattr("flow_sdk.cli.auth.secrets.is_secrets_enabled", lambda: False)
    store = await SecretStore.get("vault", {"prefix": "credential.user."})

    await store.save({"TOKEN": ""})  # nothing to write is not a refusal
    with pytest.raises(VaultNotEnabled):
        await store.save({"TOKEN": "t"})


async def test_load_all_decrypts_the_vault_once_and_skips_a_store_that_fails(sod_env, tmp_path, monkeypatch):
    from flow_sdk.secrets import vault

    user = await SecretStore.get("vault", {"prefix": "credential.user."})
    project = await SecretStore.get("vault", {"prefix": "credential.project.p1."})
    await user.save({"A_KEY": "a"})
    await project.save({"B_KEY": "b"})
    broken = await SecretStore.get("env_file", {"env_file_path": str(tmp_path / ".env.local")})

    reads = []
    real = vault._read_vault

    def counted():
        reads.append(1)
        return real()

    def boom(_path):
        raise OSError("unreadable")

    monkeypatch.setattr(vault, "_read_vault", counted)
    monkeypatch.setattr("flow_sdk.builtin.env_local_store.read_env_file_values", boom)

    loaded = await load_all([(user, ["A_KEY"]), (broken, ["C_KEY"]), (project, ["B_KEY"])])

    assert reads == [1]
    assert [sorted(values) for values in loaded] == [["A_KEY"], [], ["B_KEY"]]
