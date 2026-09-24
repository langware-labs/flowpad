"""A project's home page — ``home_page`` in ``project_manifest.json``.

What is under test is the policy: which asset the manifest may name (this
project's own, never another's), that an AGENT home page RESUMES its last chat
in the project instead of minting one per visit, and that the new key never
costs the ledger anything (absent when unset; a bad value degrades, it does not
fail the manifest). The worker spawn is stubbed (``Agent.use`` → a fake process)
and the Deployment is a fixed id, so the chat rows are real and the query that
finds them is the real one.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest

from flow_sdk.assets import project_manifest as manifest
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.flowpad_types.enums.process_enums import ProcessKind
from flow_sdk.responses.response import ApiSuccessResponse
from flow_sdk.schema.data_spec.project_manifest_spec import ProjectManifestSpec
from tests.unit.agent._seed import seed_agent as _agent, seed_project as _project

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval

DEPLOYMENT_ID = "deployment-home-page-test"
PUBLISHED = {"typeid": f"skill-{uuid.uuid4()}", "rel_path": "agentic-assets/skill/greet", "name": "greet"}


class _FakeProcess:
    def __init__(self, project_id: str | None):
        self.id = str(uuid.uuid4())
        self.typeid = f"agentic_process-{self.id}"
        self.project_id = project_id


@pytest.fixture
def used(monkeypatch):
    """Stub the spawn and pin the Deployment; capture every session ``use`` opens."""
    opened: list[_FakeProcess] = []

    async def _use(self, project_id=None, *, deployment=None, owner=None):
        proc = _FakeProcess(project_id)
        opened.append(proc)
        return proc

    async def _local_deployment(self):
        return SimpleNamespace(id=DEPLOYMENT_ID)

    monkeypatch.setattr(Agent, "use", _use)
    monkeypatch.setattr(Agent, "local_deployment", _local_deployment)
    return opened


def _declare(root: Path, home_page, *, entries=()) -> None:
    """Hand-write the manifest, the way it arrives in a cloned repo."""
    path = manifest.manifest_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    document = {"schema": 1, "requires": {}, "entries": list(entries), "home_page": home_page}
    path.write_text(json.dumps(document), encoding="utf-8")


async def _chat(project_id: str, *, last_active_at: int, status: str = "stopped", kind=ProcessKind.CHAT):
    proc = AgenticProcess(
        name=f"chat-{uuid.uuid4().hex[:8]}",
        deployment_id=DEPLOYMENT_ID,
        project_id=project_id,
        process_type=kind,
        status=status,
        last_active_at=last_active_at,
    )
    await proc.save()
    return proc


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


async def test_customization_surfaces_the_declared_typeid(tmp_path):
    root = tmp_path / "declared"
    project = await _project(root)
    typeid = f"agent-{uuid.uuid4()}"
    _declare(root, typeid)

    # No `.flow/customization` folder at all: the home page lives in the manifest.
    assert project.customization["home_page"] == typeid


async def test_no_manifest_is_the_default_home(tmp_path, used):
    project = await _project(tmp_path / "none")

    payload = await project.open_home_page()

    assert payload == {"asset": None, "type": None, "process_id": None, "process_typeid": None, "launched": False}
    assert project.customization["home_page"] is None
    assert used == []


async def test_an_agent_with_no_chat_yet_is_launched(tmp_path, used):
    root = tmp_path / "first"
    project = await _project(root)
    agent = await _agent(root, "intake")
    _declare(root, str(agent.typeid))

    payload = await project.open_home_page()

    assert payload["asset"] == str(agent.typeid) and payload["type"] == "agent"
    assert payload["launched"] is True and payload["process_id"] == used[0].id
    assert used[0].project_id == project.id


async def test_every_later_visit_resumes_the_most_recent_chat(tmp_path, used):
    root = tmp_path / "resume"
    project = await _project(root)
    agent = await _agent(root, "intake")
    _declare(root, str(agent.typeid))
    await _chat(project.id, last_active_at=1_000)
    latest = await _chat(project.id, last_active_at=3_000)
    await _chat(project.id, last_active_at=9_000, status="failed")  # newest, but a failure
    await _chat(project.id, last_active_at=9_500, kind=ProcessKind.EXECUTION)  # not a chat
    await _chat(str(uuid.uuid4()), last_active_at=9_900)  # another project's chat

    first = await project.open_home_page()
    second = await project.open_home_page()

    assert first["process_id"] == second["process_id"] == latest.id
    assert first["launched"] is False and second["launched"] is False
    assert used == [], "a home page with a chat to resume must not open another"


async def test_an_agent_from_another_project_is_refused(tmp_path, used):
    other = tmp_path / "vendor"
    await _project(other)
    foreign = await _agent(other, "vendor-agent")
    root = tmp_path / "customer"
    project = await _project(root)
    _declare(root, str(foreign.typeid))

    assert (await project.open_home_page())["asset"] is None
    assert used == []


async def test_a_vanished_asset_falls_back_to_the_default_home(tmp_path, used):
    root = tmp_path / "vanished"
    project = await _project(root)
    _declare(root, f"agent-{uuid.uuid4()}")

    assert (await project.open_home_page())["asset"] is None
    assert used == []


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
