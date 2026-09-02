"""The two warnings the Secrets card shows, both strictly value-free.

- `missing-value`: a declaration this machine cannot satisfy. This is what a
  receiver of a shared project sees for every secret whose value they have not
  provided yet.
- `value-changed`: the value behind a declaration is no longer the one that was
  provided. `.env.local` is hand-edited, so a stale binding is worth flagging.
"""

import json

import pytest

from flow_sdk.app.actions.membership_sync import materialize_project_secret_origins
from flow_sdk.builtin.env_local_store import write_env_local
from flow_sdk.builtin.project import Project
from flow_sdk.cli.auth.secrets import write_secret
from flow_sdk.schema.type_info import register_all

register_all()


async def _project(tmp_path, name="warn-proj"):
    tmp_path.mkdir(parents=True, exist_ok=True)
    project = Project(name=str(tmp_path / name))
    project.fs_storage_mount_path = str(tmp_path)
    await project.save()
    return project


async def _status_rows(project):
    resp = await project.secret_resolve_status()
    assert resp.status == "SUCCESS", resp
    return {row["env_var"]: row for row in resp.data["secrets"]}


@pytest.mark.asyncio
async def test_declared_with_no_value_anywhere_warns_missing(tmp_path, sod_env):
    project = await _project(tmp_path)
    await project.add_secret_pointer(
        name="openai", env_var="OPENAI_API_KEY", scope="private",
        locator={"kind": "env-local", "env_key": "OPENAI_API_KEY"},
    )

    row = (await _status_rows(project))["OPENAI_API_KEY"]

    assert row["status"] == "missing"
    assert row["warning"] == "missing-value"
    assert row["found_in"] is None


@pytest.mark.asyncio
async def test_a_local_store_satisfies_a_provider_declaration(tmp_path, sod_env):
    """The local stores exist for USAGE, so a value under the right env var
    satisfies the declaration whatever provider it names. Reporting this missing
    would be wrong."""
    project = await _project(tmp_path)
    await project.add_secret_pointer(
        name="gcp-secret", env_var="GCP_TOKEN", scope="private",
        locator={"kind": "gcp", "gcp_project": "p", "secret": "s", "version": "latest"},
    )
    write_env_local(project, "GCP_TOKEN", "value-from-env-local")

    row = (await _status_rows(project))["GCP_TOKEN"]

    assert row["status"] == "available"
    assert row["found_in"] == "env-local"
    assert row["warning"] is None


@pytest.mark.asyncio
async def test_sodot_by_env_var_name_also_satisfies(tmp_path, sod_env):
    project = await _project(tmp_path)
    await project.add_secret_pointer(
        name="1p", env_var="OP_TOKEN", scope="private",
        locator={"kind": "1password", "vault": "v", "item": "i", "field": "credential"},
    )
    write_secret("OP_TOKEN", "value-in-sodot")

    row = (await _status_rows(project))["OP_TOKEN"]

    assert row["found_in"] == "sodot"
    assert row["warning"] is None


@pytest.mark.asyncio
async def test_receiver_of_a_shared_project_is_warned_about_every_secret(tmp_path, sod_env):
    """The whole point of shipping `local` declarations across the wire."""
    receiver = await _project(tmp_path / "bob", "bob-proj")
    payload = {
        "shared_secret_origins": {
            "secret_origin-a": {
                "name": "Stripe", "env_var": "STRIPE_API_KEY", "kind": "flowpad-hub",
                "locator": {"kind": "flowpad-hub", "secret_id": "sec_1"},
            },
            "secret_origin-b": {
                "name": "Local", "env_var": "LOCAL_TOKEN", "kind": "local",
                "locator": {"kind": "local"},
            },
        }
    }
    await materialize_project_secret_origins(receiver, payload, notify=False)

    rows = await _status_rows(receiver)

    assert set(rows) == {"STRIPE_API_KEY", "LOCAL_TOKEN"}
    assert all(r["warning"] == "missing-value" for r in rows.values())


@pytest.mark.asyncio
async def test_value_change_is_detected_and_reported(tmp_path, sod_env):
    project = await _project(tmp_path)
    await project.add_secret_pointer(
        name="openai", env_var="OPENAI_API_KEY", scope="private",
        locator={"kind": "env-local", "env_key": "OPENAI_API_KEY"},
    )
    await project.provide_secret(env_var="OPENAI_API_KEY", value="sk-original")

    first = await project.secret_drift_status()
    assert first.data["secrets"][0]["warning"] is None, "no drift right after providing"

    # Hand-edit the file, exactly as a user would.
    write_env_local(project, "OPENAI_API_KEY", "sk-edited-by-hand")

    second = await project.secret_drift_status()
    assert second.data["secrets"][0]["warning"] == "value-changed"


@pytest.mark.asyncio
async def test_no_value_and_no_digest_ever_leaves_the_boundary(tmp_path, sod_env):
    project = await _project(tmp_path)
    # SHARED: the sidecar is one of the surfaces enumerated below, and a private
    # declaration no longer writes one — so the widest boundary check needs the
    # scope that actually produces every surface.
    await project.add_secret_pointer(
        name="openai", env_var="OPENAI_API_KEY", scope="shared",
        locator={"kind": "env-local", "env_key": "OPENAI_API_KEY"},
    )
    await project.provide_secret(env_var="OPENAI_API_KEY", value="sk-super-secret")

    from flow_sdk.builtin.secret_origin_digest import read_digest

    digest = read_digest(str(project.id), "OPENAI_API_KEY")
    assert digest, "a baseline should have been recorded"

    surfaces = [
        json.dumps((await project.secret_resolve_status()).data),
        json.dumps((await project.secret_drift_status()).data),
        json.dumps((await project.env_local_status()).data),
        json.dumps(project._hub_body(), default=str),
        json.dumps(await project._shared_secret_origin_payload()),
        (tmp_path / "assets" / "sodot" / "OPENAI_API_KEY.json").read_text(),
    ]
    for blob in surfaces:
        assert "sk-super-secret" not in blob
        assert digest not in blob, "the digest is per-machine and must not travel either"


@pytest.mark.asyncio
async def test_a_local_declaration_is_not_satisfied_by_the_other_local_store(tmp_path, sod_env):
    """A declaration naming a LOCAL store is answered by that store alone.

    The union above is a stopgap for external slots that cannot resolve locally
    at all. Applying it here claimed a credential was Connected off a value in a
    file the declaration does not read — `resolve_project_secrets` resolves
    through the named driver, so no worker would have been handed it either.
    That is exactly how an OpenRouter key read "Connected" in Connections and
    "no openrouter key is stored on this machine" on LLM sources at the same
    time.
    """
    project = await _project(tmp_path)
    await project.add_secret_pointer(
        name="openrouter", env_var="OPENROUTER_API_KEY", scope="private",
        locator={"kind": "local", "sod_name": "lm_api.openrouter"},
    )
    write_env_local(project, "OPENROUTER_API_KEY", "value-in-the-wrong-store")

    row = (await _status_rows(project))["OPENROUTER_API_KEY"]

    assert row["status"] == "missing"
    # `wrong-store`, not `missing-value`: there IS a value, somewhere this
    # declaration does not read, and saying so is what tells someone what to do.
    assert row["warning"] == "wrong-store"
    assert row["found_in"] == "env-local"


@pytest.mark.asyncio
async def test_the_named_local_store_does_satisfy_it(tmp_path, sod_env):
    """The other half of the rule — and the path the Connections `Set up` panel
    takes, which is why an LLM key added there becomes visible to funding."""
    project = await _project(tmp_path)
    await project.add_secret_pointer(
        name="openrouter", env_var="OPENROUTER_API_KEY", scope="private",
        locator={"kind": "local", "sod_name": "lm_api.openrouter"},
    )
    await project.provide_secret(env_var="OPENROUTER_API_KEY", value="sk-or-test")

    row = (await _status_rows(project))["OPENROUTER_API_KEY"]

    assert row["status"] == "available"
    assert row["warning"] is None

    # And it landed under the name the LLM funding resolver reads, which is the
    # whole point of routing the declaration at the sod store.
    from flow_sdk.cli.auth.lm_api_keys import get_lm_api

    assert get_lm_api("openrouter") == "sk-or-test"
