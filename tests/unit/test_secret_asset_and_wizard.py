"""Asset-backed secret reference + the setup-wizard backend.

Covers the extensions on top of the robust SecretOrigin design:
- the value-free reference is written as ``assets/sodot/<name>.json`` with the
  CONVERGENT id (== ``SecretOrigin.key()``, never path-derived);
- ``secret-resolve-status`` reports available/missing via ``driver.can_resolve``;
- ``provide-secret`` writes a user value into the designated SOD store (sodot or
  the project's git-ignored ``.env.local``) — never into the reference json;
- worker launch then resolves the value from that store.
"""
import json

import pytest

from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.cli_drivers import apply_worker_secret_env
from flow_sdk.builtin.project import Project
from flow_sdk.builtin.secret_origin import SecretOrigin, assert_value_free
from flow_sdk.builtin.secret_origin_field import SECRET_ORIGIN_ADAPTER
from flow_sdk.schema.type_info import register_all

register_all()


async def _project(tmp_path):
    project = Project(name=str(tmp_path / "sec-proj"))
    project.fs_storage_mount_path = str(tmp_path)
    await project.save()
    return project


@pytest.mark.asyncio
async def test_add_secret_pointer_writes_value_free_convergent_asset(tmp_path):
    project = await _project(tmp_path)
    resp = await project.add_secret_pointer(
        name="openai", env_var="OPENAI_API_KEY", scope="private",
        locator={"kind": "env-local", "env_key": "OPENAI_API_KEY"},
    )
    assert resp.status == "SUCCESS", resp

    asset = tmp_path / "assets" / "sodot" / "openai.json"
    assert asset.exists(), "reference json not written under assets/sodot/"
    doc = json.loads(asset.read_text())
    assert_value_free(doc)  # no plaintext key
    # Convergent id: the file id equals the SecretOrigin key() for that locator.
    loc = SECRET_ORIGIN_ADAPTER.validate_python({"kind": "env-local", "env_key": "OPENAI_API_KEY"})
    assert doc["data"]["id"] == SecretOrigin.id_for_locator(loc)
    assert doc["data"]["sod_store"] == "env-local"


@pytest.mark.asyncio
async def test_resolve_status_and_provide_env_local_then_worker_resolves(tmp_path):
    project = await _project(tmp_path)
    await project.add_secret_pointer(
        name="openai", env_var="OPENAI_API_KEY", scope="private",
        locator={"kind": "env-local", "env_key": "OPENAI_API_KEY"},
    )

    st = await project.secret_resolve_status()
    rows = st.data["secrets"]
    assert len(rows) == 1 and rows[0]["status"] == "missing" and rows[0]["kind"] == "env-local"

    # provide → writes .env.local (git-ignored), never the reference json
    prov = await project.provide_secret(env_var="OPENAI_API_KEY", value="sk-env-secret")
    assert prov.status == "SUCCESS", prov
    gi = (tmp_path / ".gitignore").read_text()
    assert ".env.local" in gi
    assert "sk-env-secret" in (tmp_path / ".env.local").read_text()
    assert "sk-env-secret" not in (tmp_path / "assets" / "sodot" / "openai.json").read_text()

    st2 = await project.secret_resolve_status()
    assert st2.data["secrets"][0]["status"] == "available"

    # worker launch resolves the value into the transient env only
    process = await AgenticProcess(project_id=project.id, workdir=str(tmp_path)).save()
    env: dict = {}
    await apply_worker_secret_env(env, process)
    assert env.get("OPENAI_API_KEY") == "sk-env-secret"


@pytest.mark.asyncio
async def test_provide_secret_local_sodot(tmp_path, sod_env):
    project = await _project(tmp_path)
    await project.add_secret_pointer(name="openai", env_var="OPENAI_API_KEY", sod_name="openai")

    assert (await project.secret_resolve_status()).data["secrets"][0]["status"] == "missing"
    prov = await project.provide_secret(env_var="OPENAI_API_KEY", value="sk-sodot-secret")
    assert prov.status == "SUCCESS", prov
    assert (await project.secret_resolve_status()).data["secrets"][0]["status"] == "available"

    process = await AgenticProcess(project_id=project.id, workdir=str(tmp_path)).save()
    env: dict = {}
    await apply_worker_secret_env(env, process)
    assert env.get("OPENAI_API_KEY") == "sk-sodot-secret"


@pytest.mark.asyncio
async def test_env_local_pointer_shares_value_free_across_hub(tmp_path):
    """Hub conversation/project sharing carries the value-free reference (name,
    env_var, provider, sod_store) — never a value — and converges on one id."""
    from flow_sdk.app.actions.membership_sync import materialize_project_secret_origins

    alice = await _project(tmp_path / "a")
    await alice.add_secret_pointer(
        name="openai", env_var="OPENAI_API_KEY", scope="shared",
        locator={"kind": "env-local", "env_key": "OPENAI_API_KEY"}, sod_store="env-local",
    )
    payload = await alice._shared_secret_origin_payload()
    blob = json.dumps(payload)
    assert "OPENAI_API_KEY" in blob and "env-local" in blob and "value" not in blob
    item = next(iter(payload.values()))
    assert item["kind"] == "env-local" and item["sod_store"] == "env-local"

    bob = await _project(tmp_path / "b")
    n = await materialize_project_secret_origins(bob, {"shared_secret_origins": payload}, notify=False)
    assert n == 1
    got = bob.secret_origins[0]
    assert got["env_var"] == "OPENAI_API_KEY" and got["locator"]["kind"] == "env-local"
    assert got["sod_store"] == "env-local"
    # Convergent id: alice's shared typeid == bob's materialized typeid.
    assert next(iter(payload.keys())).split("-", 1)[1] == got["typeid"].split("-", 1)[1]
    # Bob can't resolve it yet → wizard path (his .env.local has no value).
    st = await bob.secret_resolve_status()
    assert st.data["secrets"][0]["status"] == "missing"


@pytest.mark.asyncio
async def test_provide_external_provider_is_coming_soon(tmp_path):
    project = await _project(tmp_path)
    await project.add_secret_pointer(
        name="gcpkey", env_var="GCP_KEY", scope="shared",
        locator={"kind": "gcp", "gcp_project": "p", "secret": "s", "version": "latest"},
    )
    st = await project.secret_resolve_status()
    row = st.data["secrets"][0]
    assert row["status"] == "missing" and row["setup_hint"].get("coming_soon") is True
    prov = await project.provide_secret(env_var="GCP_KEY", value="x")
    assert prov.status == "FAIL" and "coming soon" in prov.message.lower()


# ── the .env.local hard block + detected-keys status ──────────────────────────


def _git_init(path):
    import subprocess

    subprocess.run(["git", "init", "-q"], cwd=str(path), capture_output=True, timeout=10)


@pytest.mark.asyncio
async def test_env_local_status_reports_names_only(tmp_path):
    project = await _project(tmp_path)
    (tmp_path / ".env.local").write_text(
        "# comment\nOPENAI_API_KEY=sk-must-not-appear\nOTHER=2\n", encoding="utf-8"
    )
    await project.add_secret_pointer(
        name="openai", env_var="OPENAI_API_KEY", scope="private",
        locator={"kind": "env-local", "env_key": "OPENAI_API_KEY"},
    )

    resp = await project.env_local_status()

    assert resp.status == "SUCCESS", resp
    data = resp.data
    assert [k["key"] for k in data["keys"]] == ["OPENAI_API_KEY", "OTHER"]
    assert [k["line"] for k in data["keys"]] == [2, 3]
    # The declared flag is what lets the UI offer "declare" only where it helps.
    assert data["keys"][0]["declared"] is True
    assert data["keys"][1]["declared"] is False
    # No value crosses this boundary, ever.
    assert "sk-must-not-appear" not in json.dumps(data)


@pytest.mark.asyncio
async def test_env_local_status_flags_the_hard_block(tmp_path):
    project = await _project(tmp_path)
    _git_init(tmp_path)  # a repo with no .gitignore — .env.local is committable

    resp = await project.env_local_status()

    assert resp.data["blocked"] is True
    assert resp.data["block_code"] == "not-ignored"
    assert resp.data["gitignore"]["in_repo"] is True


@pytest.mark.asyncio
async def test_provide_secret_is_blocked_when_env_local_is_committable(tmp_path):
    project = await _project(tmp_path)
    _git_init(tmp_path)
    (tmp_path / ".gitignore").write_text("node_modules\n", encoding="utf-8")
    # Make the block unfixable-by-append: git already tracks the file.
    (tmp_path / ".env.local").write_text("EXISTING=1\n", encoding="utf-8")
    import subprocess

    subprocess.run(["git", "add", "-f", ".env.local"], cwd=str(tmp_path), capture_output=True, timeout=10)

    await project.add_secret_pointer(
        name="openai", env_var="OPENAI_API_KEY", scope="private",
        locator={"kind": "env-local", "env_key": "OPENAI_API_KEY"},
    )
    resp = await project.provide_secret(env_var="OPENAI_API_KEY", value="sk-must-not-land")

    assert resp.status == "FAIL", resp
    assert resp.data["block_code"] == "tracked"
    assert "sk-must-not-land" not in (tmp_path / ".env.local").read_text()


@pytest.mark.asyncio
async def test_provide_secret_succeeds_once_the_block_clears(tmp_path):
    """Regression guard: the block must not break the ordinary path."""
    project = await _project(tmp_path)
    _git_init(tmp_path)
    await project.add_secret_pointer(
        name="openai", env_var="OPENAI_API_KEY", scope="private",
        locator={"kind": "env-local", "env_key": "OPENAI_API_KEY"},
    )

    resp = await project.provide_secret(env_var="OPENAI_API_KEY", value="sk-fine")

    assert resp.status == "SUCCESS", resp
    assert "sk-fine" in (tmp_path / ".env.local").read_text()
    assert ".env.local" in (tmp_path / ".gitignore").read_text()
