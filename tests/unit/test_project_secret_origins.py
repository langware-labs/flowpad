import json

import pytest

from flow_sdk.api.type_id import TypeId
from flow_sdk.app.actions.membership_sync import materialize_project_secret_origins
from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.cli_drivers import apply_worker_env, apply_worker_secret_env
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import AgentOptions
from flow_sdk.builtin.project import Project
from flow_sdk.builtin.secret_origin import SecretOrigin
from flow_sdk.cli.auth.secrets import write_secret
from flow_sdk.schema.type_info import register_all

register_all()


async def _make_project(tmp_path, name="secret-proj"):
    project = Project(name=str(tmp_path / name))
    await project.save()
    return project


@pytest.mark.asyncio
async def test_add_local_secret_pointer_is_private_and_value_free(tmp_path):
    project = await _make_project(tmp_path)

    resp = await project.add_secret_pointer(
        name="OpenAI",
        env_var="OPENAI_API_KEY",
        sod_name="openai",
    )

    assert resp.status == "SUCCESS"
    assert len(project.secret_origins) == 1
    summary = project.secret_origins[0]
    assert summary["scope"] == "private"
    assert summary["locator"] == {"kind": "local", "sod_name": "openai"}

    secret = await SecretOrigin.get_by_id(summary["typeid"].split("-", 1)[1])
    assert secret is not None
    assert project.context_of_type("secret_origin", bucket="private") == [secret.typeid]
    assert project.context_of_type("secret_origin", bucket="shared") == []

    payload = json.dumps(project.model_dump(mode="json"), default=str)
    assert "OPENAI_API_KEY" in payload
    assert "sk-" not in payload
    hub_body = json.dumps(project._hub_body(), default=str)
    assert str(secret.typeid) not in hub_body
    assert "openai" not in hub_body


@pytest.mark.asyncio
async def test_shared_hub_secret_pointer_share_payload_is_metadata_only(tmp_path):
    project = await _make_project(tmp_path)

    # A local declaration IS shareable now: the receiver has to see it to be
    # told its value is missing. Only the machine-specific coordinate is
    # stripped from the wire (below).
    local_shared = await project.add_secret_pointer(
        name="Local",
        env_var="LOCAL_TOKEN",
        scope="shared",
        sod_name="local-token",
    )
    assert local_shared.status == "SUCCESS", local_shared

    resp = await project.add_secret_pointer(
        name="Stripe",
        env_var="STRIPE_API_KEY",
        scope="shared",
        kind="flowpad-hub",
        secret_id="sec_123",
    )
    assert resp.status == "SUCCESS"

    shared = await project._shared_secret_origin_payload()
    assert len(shared) == 2
    by_env = {item["env_var"]: item for item in shared.values()}

    stripe = by_env["STRIPE_API_KEY"]
    assert stripe["name"] == "Stripe"
    assert stripe["project_id"] == str(project.id)
    assert stripe["kind"] == "flowpad-hub"
    assert stripe["sod_store"] == "sodot"
    assert stripe["locator"]["kind"] == "flowpad-hub"
    assert stripe["locator"]["secret_id"] == "sec_123"
    # The local declaration travels WITHOUT its sod_name — that name points at
    # an entry in this machine's keychain and means nothing anywhere else.
    assert by_env["LOCAL_TOKEN"]["locator"] == {"kind": "local"}
    assert "local-token" not in json.dumps(shared)

    assert "shared_secret_origins" not in project._hub_body()
    assert "sec_123" in json.dumps(shared)
    assert "sk-" not in json.dumps(shared)


@pytest.mark.asyncio
async def test_receive_materializes_shared_secret_pointers(tmp_path):
    project = await _make_project(tmp_path)
    payload = {
        "shared_secret_origins": {
            "secret_origin-any": {
                "name": "Stripe",
                "env_var": "STRIPE_API_KEY",
                "kind": "flowpad-hub",
                "locator": {"kind": "flowpad-hub", "secret_id": "sec_123"},
            },
            "secret_origin-local": {
                "name": "Local",
                "env_var": "LOCAL_TOKEN",
                "kind": "local",
                "locator": {"kind": "local", "sod_name": "local-token"},
            },
        }
    }

    count = await materialize_project_secret_origins(project, payload, notify=False)

    # BOTH declarations land — a receiver must see the local one to be warned
    # its value is missing here.
    assert count == 2
    by_env = {row["env_var"]: row for row in project.secret_origins}
    assert set(by_env) == {"STRIPE_API_KEY", "LOCAL_TOKEN"}
    assert by_env["STRIPE_API_KEY"]["scope"] == "shared"
    assert by_env["STRIPE_API_KEY"]["locator"]["secret_id"] == "sec_123"
    assert project.context_of_type("secret_origin", bucket="private") == []
    assert len(project.context_of_type("secret_origin", bucket="shared")) == 2
    mirrored = project.shared_secret_origins[by_env["STRIPE_API_KEY"]["typeid"]]
    assert mirrored["name"] == "Stripe"
    assert mirrored["project_id"] == str(project.id)
    assert mirrored["env_var"] == "STRIPE_API_KEY"
    assert mirrored["sod_store"] == "sodot"
    assert mirrored["locator"]["secret_id"] == "sec_123"


@pytest.mark.asyncio
async def test_receiver_reads_shared_pointer_without_sidecar(tmp_path):
    """Receiver-mirror path: a project shared TO this instance carries the
    value-free reference in the mirrored ``shared_secret_origins`` map, but the
    per-typeid ``shared_context_entity_data`` sidecar (populated only on the
    authoring machine) is empty. ``secret_origins`` must still resolve full
    metadata by falling back to the mirror — otherwise the received secret reads
    blank (the hub-share regression: empty name/env_var/locator on the receiver).
    """
    project = await _make_project(tmp_path)
    tid = TypeId.to_typeid("secret_origin-11111111-1111-4111-8111-111111111111")
    # Link the typeid into the shared bucket WITHOUT sidecar data, exactly as the
    # flat ``shared_context_entities`` mirror does on invitation-accept.
    project.add_shared_context_entities(tid)
    project.shared_secret_origins = {
        str(tid): {
            "name": "OpenAI",
            "env_var": "OPENAI_API_KEY",
            "kind": "env-local",
            "locator": {"kind": "env-local", "env_key": "OPENAI_API_KEY"},
            "sod_store": "env-local",
        }
    }
    assert project.get_context_entry_data(tid) is None  # sidecar genuinely empty

    summary = project.secret_origins[0]
    assert summary["typeid"] == str(tid)
    assert summary["name"] == "OpenAI"
    assert summary["env_var"] == "OPENAI_API_KEY"
    assert summary["kind"] == "env-local"
    assert summary["locator"] == {"kind": "env-local", "env_key": "OPENAI_API_KEY"}
    assert summary["sod_store"] == "env-local"
    assert summary["scope"] == "shared"


@pytest.mark.asyncio
async def test_receive_rejects_malformed_shared_secret_pointers(tmp_path):
    project = await _make_project(tmp_path)
    payload = {
        "shared_secret_origins": {
            "secret_origin-missing-id": {
                "name": "Missing ID",
                "env_var": "MISSING_ID_TOKEN",
                "kind": "flowpad-hub",
                "locator": {"kind": "flowpad-hub"},
            },
            "secret_origin-invalid-env": {
                "name": "Invalid Env",
                "env_var": "not-valid",
                "kind": "flowpad-hub",
                "locator": {"kind": "flowpad-hub", "secret_id": "sec_bad"},
            },
            "secret_origin-no-locator": {
                "name": "No Locator",
                "env_var": "NO_LOCATOR_TOKEN",
                "kind": "flowpad-hub",
            },
        }
    }

    count = await materialize_project_secret_origins(project, payload, notify=False)

    assert count == 0
    assert project.secret_origins == []
    assert project.context_of_type("secret_origin", bucket="shared") == []
    assert project.shared_secret_origins == {}


@pytest.mark.asyncio
async def test_receive_prunes_removed_shared_secret_pointers(tmp_path):
    project = await _make_project(tmp_path)
    first_payload = {
        "shared_secret_origins": {
            "secret_origin-first": {
                "name": "Stripe",
                "env_var": "STRIPE_API_KEY",
                "kind": "flowpad-hub",
                "locator": {"kind": "flowpad-hub", "secret_id": "sec_123"},
            },
            "secret_origin-second": {
                "name": "OpenAI",
                "env_var": "OPENAI_API_KEY",
                "kind": "flowpad-hub",
                "locator": {"kind": "flowpad-hub", "secret_id": "sec_456"},
            },
        }
    }
    second_payload = {
        "shared_secret_origins": {
            "secret_origin-second": {
                "name": "OpenAI",
                "env_var": "OPENAI_API_KEY",
                "kind": "flowpad-hub",
                "locator": {"kind": "flowpad-hub", "secret_id": "sec_456"},
            },
        }
    }

    assert await materialize_project_secret_origins(project, first_payload, notify=False) == 2
    by_secret_id = {s["locator"]["secret_id"]: s["typeid"] for s in project.secret_origins}
    removed_typeid = by_secret_id["sec_123"]
    kept_typeid = by_secret_id["sec_456"]

    assert await materialize_project_secret_origins(project, second_payload, notify=False) == 1

    assert [s["locator"]["secret_id"] for s in project.secret_origins] == ["sec_456"]
    assert project.context_of_type("secret_origin", bucket="shared") == [
        TypeId.to_typeid(kept_typeid)
    ]
    assert removed_typeid not in project.shared_context_entity_data
    assert list(project.shared_secret_origins) == [kept_typeid]
    kept = project.shared_secret_origins[kept_typeid]
    assert kept["env_var"] == "OPENAI_API_KEY"
    assert kept["locator"]["secret_id"] == "sec_456"


@pytest.mark.asyncio
async def test_share_sends_empty_shared_secret_origins_after_removal(tmp_path, monkeypatch):
    project = await _make_project(tmp_path)
    posts = []

    class _Creds:
        api_key = "token"

    class _Client:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, path, body):
            posts.append((path, body))
            return {"ok": True}

    monkeypatch.setattr("flow_sdk.cli.auth.credentials.load_credentials", lambda: _Creds())
    monkeypatch.setattr("flow_sdk.cloud_client.client.ApiConfig.from_env", staticmethod(lambda: object()))
    monkeypatch.setattr("flow_sdk.cloud_client.client.FlowpadClient", _Client)

    await project.add_secret_pointer(
        name="Stripe",
        env_var="STRIPE_API_KEY",
        scope="shared",
        kind="flowpad-hub",
        secret_id="sec_123",
    )
    await project.share()
    assert posts[-1][1]["shared_secret_origins"]

    await project.remove_secret_pointer(env_var="STRIPE_API_KEY")
    await project.share()

    assert posts[-1][1]["shared_secret_origins"] == {}


@pytest.mark.asyncio
async def test_worker_secret_env_resolves_from_sod_without_mutating_cli_options(tmp_path, sod_env):
    write_secret("openai", "sk-test-secret")
    project = await _make_project(tmp_path)
    await project.add_secret_pointer(
        name="OpenAI",
        env_var="OPENAI_API_KEY",
        sod_name="openai",
    )
    process = await AgenticProcess(project_id=project.id, workdir=str(tmp_path)).save()

    explicit_env = {"OPENAI_API_KEY": "explicit"}
    await apply_worker_secret_env(explicit_env, process)
    assert explicit_env["OPENAI_API_KEY"] == "explicit"

    cmd = AgentOptions(env_vars={})
    apply_worker_env(cmd.env_vars, process)
    transient_env = dict(cmd.env_vars)
    await apply_worker_secret_env(transient_env, process)

    assert transient_env["OPENAI_API_KEY"] == "sk-test-secret"
    assert "OPENAI_API_KEY" not in cmd.env_vars
    assert "sk-test-secret" not in json.dumps(cmd.to_json(), default=str)
