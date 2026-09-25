"""Typed folder I/O for an agentic run: a DataSpec in, a DataSpec out.

``AgenticProcess.run(prompt, input=cv, output_spec=CVSpec)`` saves ``cv`` into the run's
``execution/input``, tells the agent the exact layout to write into ``execution/output``, and loads it
back into ``value``. Every case runs a real headless turn on the mock worker, whose file actions
(``turn.read/write/edit/rename/delete``) act on those folders — and whose handlers the test writes when
it needs the agent to get it wrong.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import ClassVar

import pytest

from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process import process_io
from flow_sdk.schema.data_spec import DataSpec
from flow_sdk.schema.data_spec.io import Text
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode
from tests.utils.mock_worker import MockDriver

pytestmark = [pytest.mark.timeout(10), pytest.mark.usefixtures("tmp_records_root")]  # do not increase timeout without approval


class CVSpec(DataSpec):
    spec_kind: ClassVar[str] = "test_typed_io.cv"
    name: str
    email: str
    skills: list[str] = []
    body: Text = ""


CV = CVSpec(name="Dana Levi", email="dana@x.io", body="raw text from cv.pdf")


def _review(turn) -> str:
    """The agent a caller hopes for: read the input CV, write the reviewed one in the same layout."""
    cv = json.loads(turn.read(turn.input_dir / "cv.json"))
    turn.write(turn.output_dir / "cv.json", json.dumps({**cv, "skills": ["Go", "Postgres"]}))
    turn.write(turn.output_dir / "body.md", "# Dana Levi\n## Experience\n" + turn.read(turn.input_dir / "body.md"))
    return "Your CV was reviewed"


@pytest.fixture
def mock(monkeypatch, tmp_path):
    def install(behavior, **kw) -> MockDriver:
        driver = MockDriver(tmp_path / "transcripts", behavior=behavior, **kw)
        monkeypatch.setattr("flow_sdk.builtin.agentic_process.agentic_process.get_driver", lambda _t: driver)
        return driver
    return install


# ── run(): the happy path ───────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_cv_in_is_a_cv_out(initialize_test_db, mock, tmp_path):
    driver = mock(_review)
    answer = await AgenticProcess.run("Review and convert the input CV", input=CV, output_spec=CVSpec,
                                      workdir=str(tmp_path))
    assert answer.exit_code is ExitCode.OK and answer.text == "Your CV was reviewed"
    assert isinstance(answer.value, CVSpec)
    assert answer.value.skills == ["Go", "Postgres"] and answer.value.body.startswith("# Dana Levi")
    assert answer.files == ["body.md", "cv.json"]
    assert driver.received_prompts == ["Review and convert the input CV"]


@pytest.mark.asyncio
async def test_the_agent_is_told_both_folders_and_the_exact_layout(initialize_test_db, mock, tmp_path):
    driver = mock(_review)
    await AgenticProcess.run("x", input=CV, output_spec=CVSpec, workdir=str(tmp_path))
    told = driver.turns[0].instructions
    turn = driver.turns[0]
    assert str(turn.input_dir) in told and str(turn.output_dir) in told
    assert "`cv.json` — JSON with the fields: name, email, skills" in told
    assert "`body.md` — the `body` text" in told
    assert '"body"' not in told.split("schema")[-1], "the body is a file, not a JSON key"


@pytest.mark.asyncio
async def test_the_input_folder_is_mounted_for_the_worker(initialize_test_db, mock, tmp_path):
    seen: list[list[str]] = []

    def look(turn):
        seen.append(list(turn.process.resolved_add_dirs))
        return _review(turn)

    driver = mock(look)
    await AgenticProcess.run("x", input=CV, output_spec=CVSpec, workdir=str(tmp_path))
    assert str(driver.turns[0].input_dir) in seen[0]


@pytest.mark.asyncio
async def test_a_draft_edited_then_renamed_into_place_counts(initialize_test_db, mock, tmp_path):
    def draft_then_rename(turn):
        turn.write(turn.output_dir / "draft.json", json.dumps({"name": "Dana", "email": "OLD"}))
        turn.edit(turn.output_dir / "draft.json", "OLD", "dana@x.io")
        turn.rename(turn.output_dir / "draft.json", turn.output_dir / "cv.json")
        return "done"

    mock(draft_then_rename)
    answer = await AgenticProcess.run("x", output_spec=CVSpec, workdir=str(tmp_path))
    assert answer.ok and answer.value.email == "dana@x.io" and answer.files == ["cv.json"]


@pytest.mark.asyncio
async def test_the_output_spec_may_be_named_by_its_kind(initialize_test_db, mock, tmp_path):
    mock(_review)
    answer = await AgenticProcess.run("x", input=CV, output_spec="test_typed_io.cv", workdir=str(tmp_path))
    assert isinstance(answer.value, CVSpec)


# ── run(): an agent that gets it wrong — the test writes the handler ───────────────────────────────


@pytest.mark.asyncio
async def test_no_output_is_not_yet_and_keeps_the_reply(initialize_test_db, mock, tmp_path):
    mock(lambda turn: "I could not find the CV")
    answer = await AgenticProcess.run("x", input=CV, output_spec=CVSpec, workdir=str(tmp_path))
    assert answer.exit_code is ExitCode.NOT_YET and answer.value is None
    assert "not a valid CVSpec" in answer.detail and answer.text == "I could not find the CV"


@pytest.mark.asyncio
async def test_the_right_data_under_the_wrong_file_name_is_refused(initialize_test_db, mock, tmp_path):
    def wrong_name(turn, path, content):
        _write = (path.parent / "cv_spec.json") if path.name == "cv.json" else path
        _write.parent.mkdir(parents=True, exist_ok=True)
        _write.write_text(content)

    mock(_review, handlers={"write": wrong_name})
    answer = await AgenticProcess.run("x", input=CV, output_spec=CVSpec, workdir=str(tmp_path))
    assert answer.exit_code is ExitCode.NOT_YET and "cv_spec.json" in answer.files


@pytest.mark.asyncio
async def test_a_field_of_the_wrong_type_is_refused(initialize_test_db, mock, tmp_path):
    def bad_field(turn):
        turn.write(turn.output_dir / "cv.json", json.dumps({"name": "Dana", "email": "d@x.io", "skills": "Go"}))
        return "done"

    mock(bad_field)
    answer = await AgenticProcess.run("x", output_spec=CVSpec, workdir=str(tmp_path))
    assert answer.exit_code is ExitCode.NOT_YET and "1 validation error for CVSpec" in answer.detail


@pytest.mark.asyncio
async def test_a_corrupt_document_is_refused(initialize_test_db, mock, tmp_path):
    mock(lambda turn: (turn.write(turn.output_dir / "cv.json", "{not json"), "done")[1])
    answer = await AgenticProcess.run("x", output_spec=CVSpec, workdir=str(tmp_path))
    assert answer.exit_code is ExitCode.NOT_YET and answer.value is None


@pytest.mark.asyncio
async def test_an_unknown_kind_is_refused_before_anything_runs(initialize_test_db, mock, tmp_path):
    driver = mock(_review)
    with pytest.raises(ValueError, match="unknown kind"):
        await AgenticProcess.run("x", output_spec="test_typed_io.nope", workdir=str(tmp_path))
    with pytest.raises(TypeError, match="DataSpec instance"):
        await AgenticProcess.run("x", input={"name": "Dana"}, workdir=str(tmp_path))
    assert driver.received_prompts == []


# ── plain runs and the pieces around them ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_plain_run_still_lists_and_registers_what_it_wrote(initialize_test_db, mock, tmp_path):
    from flow_sdk.builtin.artifact import Artifact

    mock(lambda turn: (turn.write(turn.output_dir / "notes.md", "# notes"), "wrote notes")[1])
    answer = await AgenticProcess.run("Write notes", workdir=str(tmp_path))
    assert answer.ok and answer.value is None and answer.files == ["notes.md"]
    rows = await Artifact.get_all({"generated_by": answer.executor})
    assert [r.name for r in rows] == ["notes.md"]

    proc = await AgenticProcess.get_by_typeid(answer.executor)
    await process_io.register_outputs(proc, answer.files)
    assert len(await Artifact.get_all({"generated_by": answer.executor})) == 1, "a re-registration converges"


@pytest.mark.asyncio
async def test_preparing_twice_replaces_the_folder_instructions(tmp_path):
    proc = AgenticProcess(workdir=str(tmp_path), pty_mode=False)
    process_io.prepare_io(proc)
    process_io.prepare_io(proc, input=CV, output_spec=CVSpec)
    told = proc.context_data["instructions"]
    assert told.count("Write any files you produce to") == 1 and "Your input is in" in told


@pytest.mark.asyncio
async def test_wait_looks_as_often_as_the_driver_says(mock, tmp_path):
    mock(_review)
    proc = AgenticProcess(workdir=str(tmp_path), pty_mode=False)
    assert proc._status_poll_seconds() == pytest.approx(0.01)


# ── Agent.launch: the same contract, and the agent's declared shapes ────────────────────────────


@pytest.fixture
def home(fresh_user_scope):
    fresh_user_scope.mkdir(exist_ok=True)
    return fresh_user_scope


@pytest.mark.asyncio
async def test_an_agent_launch_takes_input_and_output_spec(initialize_test_db, home, mock):
    from flow_sdk.builtin.agent import Agent

    mock(_review)
    agent = Agent(name="cv-reviewer", system_prompt="You review CVs.")
    await agent.save()
    answer = await agent.launch("Review the CV", input=CV, output_spec=CVSpec, wait=True)
    assert answer.ok and isinstance(answer.value, CVSpec) and answer.value.skills == ["Go", "Postgres"]


@pytest.mark.asyncio
async def test_an_agents_declared_output_is_the_default_output_spec(initialize_test_db, home, mock):
    from flow_sdk.builtin.agent import Agent

    def score(turn):
        turn.write(turn.output_dir / next(p for p in _main_names(turn)), json.dumps({"score": 8}))
        return "scored"

    mock(score)
    agent = Agent(name="cv-scorer", system_prompt="You score CVs.", output={"score": "int"})
    await agent.save()
    answer = await agent.launch("Score the CV", wait=True)
    assert answer.ok and answer.value.score == 8


def _main_names(turn):
    """The main document name the agent was told (``<kind>.json``), read off its instructions."""
    for line in turn.instructions.splitlines():
        if "JSON with the fields" in line:
            yield line.split("`")[1]


@pytest.mark.asyncio
async def test_an_input_that_is_not_the_agents_declared_input_is_refused(initialize_test_db, home, mock):
    from flow_sdk.builtin.agent import Agent
    from flow_sdk.core.compute.declared_value import DeclaredShapeError

    driver = mock(_review)
    agent = Agent(name="cv-only", system_prompt="x", input={"name": "string", "email": "string", "years": "int"})
    await agent.save()
    with pytest.raises(DeclaredShapeError):
        await agent.launch("x", input=CV, wait=True)
    assert driver.received_prompts == []


# ── worker selection: an unset worker follows the user's choice ─────────────────────────────────


@pytest.mark.asyncio
async def test_an_unset_worker_follows_the_selected_harness(monkeypatch, tmp_path):
    from flow_sdk.flowpad_types.enums import WorkerType

    async def selected():
        return WorkerType.CODEX.value

    monkeypatch.delenv("FLOWPAD_DEFAULT_WORKER", raising=False)
    monkeypatch.setattr("flow_sdk.core.capabilities.registry.resolve_default_worker_type", selected)
    proc = AgenticProcess(workdir=str(tmp_path))
    _ = proc.driver  # cached before resolution …
    await proc.resolve_worker_type()
    assert proc.worker_type == WorkerType.CODEX and "driver" not in proc.__dict__, "… and dropped after"

    explicit = AgenticProcess(workdir=str(tmp_path), worker_type=WorkerType.COPILOT)
    await explicit.resolve_worker_type()
    assert explicit.worker_type == WorkerType.COPILOT, "an explicit worker is kept"

    started = AgenticProcess(workdir=str(tmp_path), session_id="s-1")
    await started.resolve_worker_type()
    assert started.worker_type is None, "a started process keeps the worker it started with"

    monkeypatch.setenv("FLOWPAD_DEFAULT_WORKER", "claude")
    hooked = AgenticProcess(workdir=str(tmp_path))
    await hooked.resolve_worker_type()
    assert hooked.worker_type is None, "the env hook wins; get_driver reads it"


@pytest.mark.asyncio
async def test_no_selection_leaves_the_driver_default(monkeypatch, tmp_path):
    async def none_selected():
        raise RuntimeError("Default harness does not reference a concrete capability")

    monkeypatch.delenv("FLOWPAD_DEFAULT_WORKER", raising=False)
    monkeypatch.setattr("flow_sdk.core.capabilities.registry.resolve_default_worker_type", none_selected)
    proc = AgenticProcess(workdir=str(tmp_path))
    await proc.resolve_worker_type()
    assert proc.worker_type is None


# ── retention: recent output survives the count cap ─────────────────────────────────────────────


def test_retention_keeps_recent_output_and_prunes_the_rest(tmp_records_root, monkeypatch):
    from flow_sdk.fs_store.operations import record_retention

    monkeypatch.setattr(record_retention, "get_default_records_root", lambda: tmp_records_root)
    root = tmp_records_root / "agentic_process"
    now = time.time()

    def record(name, *, output_age_days=None, mtime_age_days=0):
        d = root / name
        d.mkdir(parents=True)
        if output_age_days is not None:
            f = d / "execution" / "output" / "cv.json"
            f.parent.mkdir(parents=True)
            f.write_text("{}")
            os.utime(f, (now - output_age_days * 86400,) * 2)
        os.utime(d, (now - mtime_age_days * 86400,) * 2)
        return d

    fresh_output = record("a-fresh-output", output_age_days=1, mtime_age_days=90)
    stale_output = record("b-stale-output", output_age_days=45, mtime_age_days=80)
    old_empty = record("c-old-empty", mtime_age_days=70)
    newest = record("d-newest", mtime_age_days=0)

    deleted = record_retention._cleanup_records("agentic_process", max_keep=1)
    assert fresh_output.exists(), "output newer than 30 days is outside the cap"
    assert newest.exists() and not stale_output.exists() and not old_empty.exists()
    assert deleted == 2


@pytest.mark.asyncio
async def test_a_run_without_a_workdir_works_in_the_callers_directory(initialize_test_db, mock, tmp_path, monkeypatch):
    """The docs fence passes no workdir; a real driver refuses a process without one ("workdir is not set")."""
    seen: list[str] = []
    mock(lambda turn: (seen.append(turn.process.workdir), "ok")[1])
    monkeypatch.chdir(tmp_path)
    answer = await AgenticProcess.run("x")
    assert answer.ok and seen == [str(tmp_path)]
