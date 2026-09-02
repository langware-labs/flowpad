"""A credential manifest on disk becomes an entity, through the real walker.

The point of making a credential a folder asset is that nothing new has to
discover it: `repo_assets_fn` already scans `agentic-assets/<family>/` in any
walked container. This drives that path rather than asserting it.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

import flow_sdk.fs_store.indexer.registrations  # noqa: F401 — registers every type
from flow_sdk.builtin.credential_spec import CredentialManifestSpec
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions
from flow_sdk.fs_store.indexer.functions.credential_spec import credential_spec_identity_key
from flow_sdk.fs_store.indexer.functions.repo_assets import repo_assets_fn
from flow_sdk.fs_store.record_types import RecordType

# Only the walker tests are async, so `asyncio` is per-test rather than a
# module mark — a module mark warns on every sync test in the file.
pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

TWILIO = {
    "schema": 1,
    "name": "twilio",
    "title": "Twilio",
    "description": "Twilio REST credentials.",
    "icon_name": "MessageSquare",
    "vars": {
        "TWILIO_ACCOUNT_SID": {"label": "Account SID", "secret": False, "account_key": True},
        "TWILIO_AUTH_TOKEN": {"label": "Auth token", "secret": True},
    },
}

SHIPPED_GMAIL = (
    Path(__file__).resolve().parents[3]
    / "flow_sdk/system_projects/flowpad_assistant/agentic-assets/credential/gmail/credential.json"
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
    assert (ent.name, ent.title) == ("twilio", "Twilio")
    # The members survive the round trip — this is what the whole feature reads.
    assert sorted(ent.vars) == ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"]
    assert ent.vars["TWILIO_AUTH_TOKEN"].secret is True
    assert ent.vars["TWILIO_ACCOUNT_SID"].secret is False


@pytest.mark.asyncio
async def test_a_manifest_carrying_a_value_yields_no_entity(folder_db, tmp_path):
    """The guard that makes this family safe to ship in git and safe to let an
    agent author: a definition names variables, it never carries one's value."""
    folder = _seed(
        tmp_path,
        "leaky",
        {**TWILIO, "name": "leaky", "vars": {"K": {"label": "x", "value": "hunter2"}}},
    )

    await _index(tmp_path)

    assert await Entity.get_by_asset_ref(str(folder)) is None


def test_identity_is_the_name_not_the_install_path(tmp_path):
    """A shipped spec's path names the INSTALL, not the asset — it differs per
    install method and moves on every upgrade. Keying identity on it forked one
    shipped definition into a row per install location (FLOWPAD-2070)."""
    first = _seed(tmp_path / "site-packages-a", "twilio", TWILIO)
    second = _seed(tmp_path / "site-packages-b", "twilio", TWILIO)

    assert credential_spec_identity_key(first) == "twilio"
    assert credential_spec_identity_key(first) == credential_spec_identity_key(second)


def test_identity_falls_back_to_the_folder_name(tmp_path):
    folder = tmp_path / "agentic-assets" / "credential" / "orphan"
    folder.mkdir(parents=True)
    assert credential_spec_identity_key(folder) == "orphan"


def test_the_shipped_gmail_definition_is_valid():
    """It ships in the wheel, so a broken one is only found by a user."""
    manifest = CredentialManifestSpec.model_validate(json.loads(SHIPPED_GMAIL.read_text()))

    assert manifest.name == "gmail"
    assert list(manifest.vars) == ["GMAIL_ADDRESS", "GMAIL_APP_PASSWORD"]
    # The address is not a secret and the password is — the distinction that
    # decides masking, and the reason a credential is a GROUP rather than a key.
    assert manifest.vars["GMAIL_ADDRESS"].secret is False
    assert manifest.vars["GMAIL_APP_PASSWORD"].secret is True
    assert manifest.default_store == "env-local"


@pytest.mark.parametrize(
    "override, why",
    [
        ({"schema": 2}, "unsupported schema"),
        ({"vars": {}}, "no variables"),
        ({"vars": {"9BAD": {"label": "x"}}}, "invalid env var name"),
        ({"default_store": "s3"}, "unknown store"),
        ({"unknown_key": 1}, "unknown key"),
    ],
)
def test_authoring_rules_are_load_errors(override, why):
    """Every rule is an ERROR, never a best-effort parse: a definition that
    silently loaded with a dropped field is worse than one visibly absent."""
    with pytest.raises(Exception):
        CredentialManifestSpec.model_validate({**TWILIO, **override})


# --- lm_provider: the LLM half ------------------------------------------------
#
# Naming a provider is the whole declaration. The store and the secret's name
# follow from it, and they have to follow CORRECTLY: `_key_sources`
# (agentic_process/cli_drivers/llm_source.py) decides a provider is funded by
# testing for a stored secret named `lm_api.<provider>`, so a manifest that
# derived anything else would declare a credential the funding resolver cannot
# see — the exact dead end this feature exists to remove.

SHIPPED_LM = {
    "openrouter": ("openrouter", "OPENROUTER_API_KEY"),
    "anthropic-key": ("anthropic", "ANTHROPIC_API_KEY"),
    "openai": ("openai", "OPENAI_API_KEY"),
}


@pytest.mark.parametrize("folder, expected", sorted(SHIPPED_LM.items()))
def test_the_shipped_llm_definitions_are_valid(folder, expected):
    provider, env_var = expected
    path = SHIPPED_GMAIL.parent.parent / folder / "credential.json"
    manifest = CredentialManifestSpec.model_validate(json.loads(path.read_text()))

    assert manifest.lm_provider == provider
    # One key, and it is the one the provider's dialect names in the environment
    # (external_apis/llm/dialects.py) — so a value already exported under that
    # name is recognisably the same credential.
    assert list(manifest.vars) == [env_var]
    assert manifest.vars[env_var].secret is True
    # Derived, not authored. This pair is what makes the key visible to funding.
    assert manifest.default_store == "sodot"
    assert manifest.vars[env_var].sod_name == f"lm_api.{provider}"


def test_the_derived_sod_name_is_what_the_funding_resolver_reads():
    """Pin the two spellings together rather than trusting them to match.

    `LM_SECRET_PREFIX` is the resolver's, `sod_name` is the manifest's. They are
    computed in different modules, and the whole feature is the claim that they
    agree."""
    from flow_sdk.builtin.llm_endpoint import LM_SECRET_PREFIX

    manifest = CredentialManifestSpec.model_validate(
        {"schema": 1, "name": "openrouter", "lm_provider": "openrouter",
         "vars": {"OPENROUTER_API_KEY": {"label": "API key"}}}
    )

    assert manifest.vars["OPENROUTER_API_KEY"].sod_name == f"{LM_SECRET_PREFIX}openrouter"


def test_a_plain_sodot_credential_is_named_by_its_variable():
    """No provider to derive from, so the variable's own name is the coordinate."""
    manifest = CredentialManifestSpec.model_validate(
        {**TWILIO, "default_store": "sodot"}
    )

    assert manifest.vars["TWILIO_AUTH_TOKEN"].sod_name == "TWILIO_AUTH_TOKEN"


def test_an_authored_sod_name_is_left_alone():
    manifest = CredentialManifestSpec.model_validate(
        {"schema": 1, "name": "custom", "default_store": "sodot",
         "vars": {"MY_TOKEN": {"sod_name": "legacy.name"}}}
    )

    assert manifest.vars["MY_TOKEN"].sod_name == "legacy.name"


def test_an_env_local_credential_derives_no_sod_name():
    """`.env.local` addresses a value by its key; a sodot name would be a second
    coordinate for the same value, free to disagree with the first."""
    manifest = CredentialManifestSpec.model_validate(TWILIO)

    assert all(v.sod_name == "" for v in manifest.vars.values())


@pytest.mark.parametrize(
    "override, why",
    [
        ({"lm_provider": "flowpad"}, "the hub login is the key; there is nothing to store"),
        ({"lm_provider": "cohere"}, "not a provider this box can hold a key for"),
        ({"lm_provider": "openai"}, "a provider names ONE key, and TWILIO declares two"),
    ],
)
def test_lm_provider_authoring_rules_are_load_errors(override, why):
    with pytest.raises(Exception):
        CredentialManifestSpec.model_validate({**TWILIO, **override})
