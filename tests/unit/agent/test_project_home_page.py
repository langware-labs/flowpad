"""A project's home page — ``home_page`` in ``project_manifest.json``.

What is under test is the policy: which asset the manifest may name (this
project's own, never another's), how it resolves (``open_home_page`` and its
``home-page`` action), and that the new key never costs the ledger anything
(absent when unset; a bad value degrades, it does not fail the manifest). What an
agent home page OPENS (its last chat, else a new one) is the frontend's —
``ui/tests/unit/project-home-page-redirect.test.ts``.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

from flow_sdk.assets import project_manifest as manifest
from flow_sdk.responses.response import ApiSuccessResponse
from flow_sdk.schema.data_spec.project_manifest_spec import ProjectManifestSpec
from tests.unit.agent._seed import seed_agent as _agent
from tests.unit.agent._seed import seed_project as _project

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval

PUBLISHED = {"typeid": f"skill-{uuid.uuid4()}", "rel_path": "agentic-assets/skill/greet", "name": "greet"}


def _declare(root: Path, home_page, *, entries=()) -> None:
    """Hand-write the manifest, the way it arrives in a cloned repo."""
    path = manifest.manifest_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    document = {"schema": 1, "requires": {}, "entries": list(entries), "home_page": home_page}
    path.write_text(json.dumps(document), encoding="utf-8")


# ── the manifest: the key costs the ledger nothing ──────────────────────────


def test_an_unset_home_page_is_not_written():
    """An older desk reads the ledger with ``extra="forbid"``: a key it does not
    know fails its whole manifest, so no manifest gains one it did not ask for."""
    assert "home_page" not in ProjectManifestSpec.empty().to_document()


@pytest.mark.parametrize("bad", ["my-agent", "agent-not-a-uuid", "", 42])
def test_a_malformed_home_page_degrades_without_failing_the_ledger(bad):
    spec = ProjectManifestSpec.model_validate({"schema": 1, "entries": [PUBLISHED], "home_page": bad})

    assert spec.home_page is None
    assert [e.typeid for e in spec.entries] == [PUBLISHED["typeid"]]


def test_set_and_clear_round_trip_and_keep_the_published_rows(tmp_path):
    manifest.publish(tmp_path, manifest.make_entry(**PUBLISHED))
    typeid = f"agent-{uuid.uuid4()}"

    manifest.set_home_page(tmp_path, typeid)
    assert manifest.read_home_page(tmp_path) == typeid
    assert manifest.read_manifest(tmp_path).find(PUBLISHED["typeid"]) is not None

    manifest.set_home_page(tmp_path, None)
    assert manifest.read_home_page(tmp_path) is None
    assert "home_page" not in json.loads(manifest.manifest_path(tmp_path).read_text(encoding="utf-8"))


def test_clearing_never_creates_a_manifest(tmp_path):
    manifest.set_home_page(tmp_path, None)
    assert not manifest.manifest_path(tmp_path).exists()


def test_a_malformed_id_is_refused_at_write_time(tmp_path):
    with pytest.raises(manifest.ManifestError):
        manifest.set_home_page(tmp_path, "my-agent")
    assert not manifest.manifest_path(tmp_path).exists()


# ── the Project: declared, resolved, and set ────────────────────────────────


async def test_no_manifest_is_the_default_home(tmp_path):
    project = await _project(tmp_path / "none")

    assert await project.open_home_page() == {"asset": None, "type": None, "declared": None}


async def test_the_declared_agent_resolves_to_its_asset(tmp_path):
    root = tmp_path / "declared"
    project = await _project(root)
    agent = await _agent(root, "intake")
    _declare(root, str(agent.typeid))

    assert await project.open_home_page() == {"asset": str(agent.typeid), "type": "agent", "declared": str(agent.typeid)}


async def test_the_home_page_action_answers_with_the_resolution(tmp_path):
    root = tmp_path / "action"
    project = await _project(root)
    agent = await _agent(root, "intake")
    _declare(root, str(agent.typeid))

    response = await project.home_page_action()

    assert isinstance(response, ApiSuccessResponse)
    assert response.data == {"asset": str(agent.typeid), "type": "agent", "declared": str(agent.typeid)}


async def test_the_home_page_is_not_customization(tmp_path):
    root = tmp_path / "not-customization"
    project = await _project(root)
    _declare(root, f"agent-{uuid.uuid4()}")

    assert "home_page" not in project.customization


async def test_an_agent_from_another_project_is_refused(tmp_path):
    other = tmp_path / "vendor"
    await _project(other)
    foreign = await _agent(other, "vendor-agent")
    root = tmp_path / "customer"
    project = await _project(root)
    _declare(root, str(foreign.typeid))

    assert (await project.open_home_page())["asset"] is None


async def test_a_vanished_asset_falls_back_to_the_default_home(tmp_path):
    root = tmp_path / "vanished"
    project = await _project(root)
    declared = f"agent-{uuid.uuid4()}"
    _declare(root, declared)

    resolved = await project.open_home_page()
    assert resolved["asset"] is None
    assert resolved["declared"] == declared, "the card shows what the file names, resolved or not"


async def test_the_set_action_writes_the_manifest_and_refuses_a_foreign_asset(tmp_path):
    other = tmp_path / "vendor"
    await _project(other)
    foreign = await _agent(other, "vendor-agent")
    root = tmp_path / "owner"
    project = await _project(root)
    agent = await _agent(root, "intake")

    ok = await project.set_home_page_action(typeid=str(agent.typeid))
    assert isinstance(ok, ApiSuccessResponse) and ok.data == {"home_page": str(agent.typeid)}
    assert manifest.read_home_page(root) == str(agent.typeid)

    refused = await project.set_home_page_action(typeid=str(foreign.typeid))
    assert not isinstance(refused, ApiSuccessResponse)
    assert manifest.read_home_page(root) == str(agent.typeid), "a refused set must not touch the manifest"

    cleared = await project.set_home_page_action(typeid="")
    assert isinstance(cleared, ApiSuccessResponse) and cleared.data == {"home_page": None}
