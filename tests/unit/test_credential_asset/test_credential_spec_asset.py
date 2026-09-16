"""A credential manifest on disk becomes an entity, through the real walker.

A credential is a folder asset, so nothing new has to discover it:
`repo_assets_fn` already scans `agentic-assets/<family>/` in any walked
container. This drives that path rather than asserting it.
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

import flow_sdk.fs_store.indexer.registrations  # noqa: F401 — registers every type
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions
from flow_sdk.fs_store.indexer.functions.repo_assets import repo_assets_fn
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.data_spec.credential_manifest_spec import CredentialManifestSpec

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

TWILIO = {
    "schema": 2,
    "name": "twilio",
    "title": "Twilio",
    "description": "Twilio REST credentials.",
    "icon_name": "MessageSquare",
    "vars": {
        "TWILIO_ACCOUNT_SID": {"label": "Account SID", "secret": False, "account_key": True},
        "TWILIO_AUTH_TOKEN": {"label": "Auth token", "secret": True},
    },
}

SHIPPED_ROOT = (
    Path(__file__).resolve().parents[3] / "flow_sdk/system_projects/flowpad_assistant/agentic-assets/credential"
)


def _seed(root: Path, name: str, manifest: dict) -> Path:
    folder = root / "agentic-assets" / "credential" / name
    folder.mkdir(parents=True)
    (folder / "credential.json").write_text(json.dumps(manifest), encoding="utf-8")
    return folder


async def _index(root: Path) -> None:
    idx = FSIndexer()
    idx.add_root(FSRef(root, record_type=RecordType.USER_HOME_FOLDER, scope="user"))
    idx.add_function(RecordType.USER_HOME_FOLDER, repo_assets_fn)
    await idx.index(IndexerOptions(verbose=False, types=[RecordType.CREDENTIAL_SPEC]))


@pytest.mark.asyncio
async def test_a_manifest_folder_becomes_an_entity(folder_db, tmp_path):
    folder = _seed(tmp_path, "twilio", TWILIO)

    await _index(tmp_path)

    ent = await Entity.get_by_asset_ref(str(folder))
    assert ent is not None, "the walker did not pick up the manifest"
    assert ent.type == "credential_spec"
    assert (ent.name, ent.title, ent.value_store) == ("twilio", "Twilio", "env")
    assert sorted(ent.vars) == ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"]
    assert ent.vars["TWILIO_AUTH_TOKEN"].secret is True
    assert ent.vars["TWILIO_ACCOUNT_SID"].secret is False


@pytest.mark.asyncio
async def test_an_indexed_credential_gets_a_v4_id_written_beside_it(folder_db, tmp_path):
    """Identity is a writable capsule: minted once, kept with the folder, not in
    credential.json (a definition carries no id of its own)."""
    folder = _seed(tmp_path, "twilio", TWILIO)

    await _index(tmp_path)

    ent = await Entity.get_by_asset_ref(str(folder))
    assert uuid.UUID(str(ent.id)).version == 4
    assert "id" not in json.loads((folder / "credential.json").read_text())


@pytest.mark.asyncio
async def test_a_manifest_carrying_a_value_yields_no_entity(folder_db, tmp_path):
    """A definition names variables, it never carries one's value."""
    folder = _seed(
        tmp_path,
        "leaky",
        {**TWILIO, "name": "leaky", "vars": {"K": {"label": "x", "value": "hunter2"}}},
    )

    await _index(tmp_path)

    assert await Entity.get_by_asset_ref(str(folder)) is None


def test_a_row_stored_by_an_earlier_build_still_loads():
    """A stored row may carry variable fields this build no longer has
    (`sod_name`). One such row must not fail every credential query — the
    manifest on disk stays strict, the row is read field by field."""
    from flow_sdk.builtin.credential_spec import CredentialSpec

    row = CredentialSpec.model_validate(
        {
            "name": "anthropic-key",
            "vars": {"ANTHROPIC_API_KEY": {"label": "API key", "sod_name": "lm_api.anthropic", "secret": True}},
        }
    )

    assert row.var_names() == ["ANTHROPIC_API_KEY"]
    assert row.vars["ANTHROPIC_API_KEY"].label == "API key"
    with pytest.raises(Exception):
        CredentialManifestSpec.model_validate(
            {**TWILIO, "vars": {"K": {"label": "x", "sod_name": "legacy"}}}
        )


def test_the_type_is_a_creatable_asset_with_a_writable_id():
    info = SchemaRegistry.get("credential_spec")

    assert info.creatable is True
    assert info.identity_carrier.writable is True
    assert info.owns_main_ref is True


@pytest.mark.parametrize("folder", sorted(p.name for p in SHIPPED_ROOT.iterdir() if p.is_dir()))
def test_every_shipped_template_commits_a_unique_v4_id(folder):
    """One template is one row on every install — the id travels in the wheel."""
    capsule = SHIPPED_ROOT / folder / ".flow" / "capsules" / "identity.json"
    ids = {
        json.loads((p / ".flow/capsules/identity.json").read_text())["data"]["id"]
        for p in SHIPPED_ROOT.iterdir()
        if p.is_dir()
    }

    entity_id = json.loads(capsule.read_text())["data"]["id"]
    assert uuid.UUID(entity_id).version == 4
    assert len(ids) == len([p for p in SHIPPED_ROOT.iterdir() if p.is_dir()]), "shipped ids must be unique"


def test_the_shipped_gmail_definition_is_valid():
    manifest = CredentialManifestSpec.model_validate(json.loads((SHIPPED_ROOT / "gmail/credential.json").read_text()))

    assert manifest.name == "gmail"
    assert list(manifest.vars) == ["GMAIL_ADDRESS", "GMAIL_APP_PASSWORD"]
    assert manifest.vars["GMAIL_ADDRESS"].secret is False
    assert manifest.vars["GMAIL_APP_PASSWORD"].secret is True
    assert manifest.value_store == "env"


def test_the_store_defaults_to_the_env_file():
    assert CredentialManifestSpec.model_validate({**TWILIO}).value_store == "env"
    assert CredentialManifestSpec.model_validate({**TWILIO, "value_store": "vault"}).value_store == "vault"


@pytest.mark.parametrize(
    "override, why",
    [
        ({"schema": 1}, "unsupported schema"),
        ({"vars": {}}, "no variables"),
        ({"vars": {"9BAD": {"label": "x"}}}, "invalid env var name"),
        ({"value_store": "s3"}, "unknown store"),
        ({"name": "has space"}, "a name is a folder name"),
        ({"unknown_key": 1}, "unknown key"),
    ],
)
def test_authoring_rules_are_load_errors(override, why):
    with pytest.raises(Exception):
        CredentialManifestSpec.model_validate({**TWILIO, **override})


SHIPPED_LM = {
    "openrouter": ("openrouter", "OPENROUTER_API_KEY"),
    "anthropic-key": ("anthropic", "ANTHROPIC_API_KEY"),
    "openai": ("openai", "OPENAI_API_KEY"),
}


@pytest.mark.parametrize("folder, expected", sorted(SHIPPED_LM.items()))
def test_the_shipped_llm_definitions_are_valid(folder, expected):
    provider, env_var = expected
    manifest = CredentialManifestSpec.model_validate(json.loads((SHIPPED_ROOT / folder / "credential.json").read_text()))

    assert manifest.lm_provider == provider
    assert list(manifest.vars) == [env_var]
    assert manifest.vars[env_var].secret is True
    # A provider key funds the machine: it lives in the vault, always.
    assert manifest.value_store == "vault"


def test_a_provider_key_is_stored_where_the_funding_resolver_reads():
    """Pin the two spellings together: the resolver tests for `lm_api.<provider>`."""
    from flow_sdk.builtin.llm_endpoint import LM_SECRET_PREFIX
    from flow_sdk.schema.data_spec.credential_contract import vault_name

    assert vault_name(scope="user", project_id=None, env_var="OPENROUTER_API_KEY", lm_provider="openrouter") == (
        f"{LM_SECRET_PREFIX}openrouter"
    )


@pytest.mark.parametrize(
    "override, why",
    [
        ({"lm_provider": "flowpad"}, "the hub login is the key; there is nothing to store"),
        ({"lm_provider": "cohere"}, "not a provider this box can hold a key for"),
        ({"lm_provider": "openai"}, "a provider names ONE key, and TWILIO declares two"),
        (
            {"lm_provider": "openai", "value_store": "env", "vars": {"OPENAI_API_KEY": {}}},
            "a provider key is never written to a file",
        ),
    ],
)
def test_lm_provider_authoring_rules_are_load_errors(override, why):
    with pytest.raises(Exception):
        CredentialManifestSpec.model_validate({**TWILIO, **override})
