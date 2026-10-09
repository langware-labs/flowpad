"""The system-prompt matrix: launch way × worker vendor × turn path → the exact ordered layers.

``docs/agent/system-prompt-layers.md``. One cell = one launch way (a row below), one
vendor (every entry of ``VENDORS``), every turn path that vendor supports:

* ``headless`` — the driver's own ``headless_prompt`` (``run_headless_turn`` is captured,
  nothing spawns),
* ``inline``   — the HTTP ``prompt`` action's ``AgenticProcess._inline_turn_context``,
* ``pty``      — the PTY launch's ``_finalized_restart_cli_options`` + ``_apply_process_assets``.

Each path's real spawn tuple is built and the text is read back out of the channel the
vendor actually reads (an argv file, a ``-c`` TOML value, an env-named dir, a generated
config). Every layer leaves a marker; the cell asserts the expected markers appear in the
expected order, exactly once each, and that no other layer's marker is there.

Coverage guards: every vendor has cells (rows are generated from ``VENDORS``), every
``LayerKey`` is expected somewhere, and every process-creation site in ``flow_sdk/`` maps
to a row — a new launch path fails ``test_every_creation_site_has_a_row`` until it gets one.
"""
from __future__ import annotations

import json
import re
import tomllib
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from flow_sdk.assets.document import read_document
from flow_sdk.builtin.agentic_process import AgenticProcess, system_prompt
from flow_sdk.builtin.agentic_process.system_prompt import LayerKey as L
from flow_sdk.flowpad_types.vendors import VENDORS
from flow_sdk.schema.data_spec.spec import DataSpec
from tests.unit.agent._seed import seed_agent, seed_project
from tests.utils.harness_installed import funding_not_under_test  # noqa: F401 — a fixture

pytestmark = [pytest.mark.asyncio, pytest.mark.usefixtures("funding_not_under_test")]

REPO = Path(__file__).resolve().parents[3]
AGENTS_DIR = REPO / "flow_sdk" / "system_projects" / "flowpad_assistant" / ".claude" / "agents"

INSTRUCTIONS = "<<L:instructions>>"

#: What each layer leaves in the text. Static where the test supplies the text; the
#: header the layer's own renderer always writes otherwise.
MARKERS: dict[L, str] = {
    L.COMMON: "<<L:common>>",
    L.COMMON_UI: "<<L:common_ui>>",
    L.INSTRUCTIONS: INSTRUCTIONS,
    L.IO: "Your result MUST be a `MatrixResult`",
    L.ALWAYS_USE_SKILLS: "This project declares that the following skill(s) apply to every request",
    L.COS_TASKS: "# Your open tasks",
    L.AGENTS: "<<agents-block>>",  # resolved per row: persona header or catalogue header
    L.AUTO_OPEN: "# Opened for you at session start",
    L.LANGUAGE: "# Language\nAlways respond in Hebrew.",
}
PERSONA_HEADER = "# You are the '{name}' agent"
CATALOGUE_HEADER = "# Embedded agent specs"


class MatrixResult(DataSpec):
    answer: str = ""


@pytest.fixture(autouse=True)
def shipped_layers(tmp_path, monkeypatch):
    """The shipped layers, as sentinel text — what is under test is where they land."""
    root = tmp_path / "shipped"
    root.mkdir()
    (root / "common.md").write_text(f"---\nid: {uuid.uuid4()}\n---\n{MARKERS[L.COMMON]}\n", encoding="utf-8")
    (root / "common_ui.md").write_text(MARKERS[L.COMMON_UI] + "\n", encoding="utf-8")
    monkeypatch.setattr(system_prompt, "SHIPPED_INSTRUCTIONS_DIR", root)
    return root


# ── launch ways ──────────────────────────────────────────────────────────────


@dataclass
class Env:
    tmp: Path
    vendor: str
    worker_type: str
    monkeypatch: pytest.MonkeyPatch

    async def project(self, **fields):
        return await seed_project(self.tmp / f"proj-{uuid.uuid4().hex[:6]}", **fields)

    async def agent(self, project, **fields):
        name = f"matrix-{uuid.uuid4().hex[:6]}"
        return await seed_agent(Path(project.fs_storage_mount_path), name, worker_type=self.vendor,
                                system_prompt=INSTRUCTIONS, project_id=project.id, **fields)

    def workdir(self) -> str:
        path = self.tmp / f"work-{uuid.uuid4().hex[:6]}"
        path.mkdir()
        return str(path)

    async def create_from_app(self, context: dict, *, pty_mode: bool = False, surface: bool = True) -> AgenticProcess:
        """The REAL ``createProcess`` action, fed the body the TS SDK's ``serializeAgenticContext`` sends.

        ``surface`` is what ``setLaunchSurface('app')`` adds (``launch-surface.test.ts`` pins that
        every app launcher sends it); a TS SDK script sends no surface.
        """
        from flow_sdk.builtin.faas.compute_node import ComputeNode

        body_context = {"workdir": self.workdir(), "worker_type": self.worker_type, **context}
        if surface:
            body_context["launch_surface"] = "app"
        info = MagicMock()
        info.someone_typeid = None
        info.get_post_data = AsyncMock(return_value={"context": body_context, "pty_mode": pty_mode})
        self.monkeypatch.setattr("flow_sdk.builtin.faas.scan_actions.get_current_request_info", lambda: info)
        resp = await ComputeNode()._scan_create_process()
        assert resp.status == "SUCCESS", getattr(resp, "message", resp)
        return await AgenticProcess.get_by_id(resp.data["id"])

    @staticmethod
    async def embed(process: AgenticProcess, persona_file: str, *, as_persona: bool) -> AgenticProcess:
        """``loadEmbeddedSubagent`` — what ``embedVibeSubagent`` / ``embedStandardAgent`` / the wizard
        launcher post after creating the process."""
        resp = await process.asset_workspace.load_embedded_subagent_action(
            asset_ref=str(AGENTS_DIR / persona_file), set_ap_persona=as_persona,
        )
        assert resp.status == "SUCCESS", getattr(resp, "message", resp)
        return await AgenticProcess.get_by_id(process.id)


@dataclass(frozen=True)
class Row:
    name: str
    build: Callable[[Env], Awaitable[AgenticProcess]]
    layers: tuple[L, ...]
    #: The persona name when ``AGENTS`` renders one ("# You are the '<name>' agent"), else None
    #: for the flat catalogue.
    persona: str | None = None
    #: The flow_sdk files whose process-creation sites this row stands for.
    sites: tuple[str, ...] = ()


async def _sdk_process(e: Env) -> AgenticProcess:
    return await AgenticProcess(worker_type=e.worker_type, workdir=e.workdir(), pty_mode=False,
                                context_data={"instructions": INSTRUCTIONS}).save()


async def _sdk_typed_run(e: Env) -> AgenticProcess:
    from flow_sdk.builtin.agentic_process.process_io import prepare_io

    process = await _sdk_process(e)
    prepare_io(process, output_spec=MatrixResult)  # what ``AgenticProcess.run(output_spec=...)`` does
    return await process.save()


async def _cli_process_start(e: Env) -> AgenticProcess:
    # ``flow process start`` (process_cmd.py) — mirrored: the command builds this inline.
    return await AgenticProcess(worker_type=e.worker_type, workdir=e.workdir(), cli_config={"permission_mode": "bypassPermissions"},
                                pty_mode=False, visible=False, load_flowpad_assistant=False).save()


async def _agent_deployment(e: Env, **agent_fields) -> AgenticProcess:
    agent = await e.agent(await e.project(), **agent_fields)
    deployment = await agent.local_deployment()
    return await (await deployment.create_process("", pty_mode=False)).save()


async def _agent_use_sdk(e: Env) -> AgenticProcess:
    agent = await e.agent(await e.project())
    return await agent.use()


async def _task_dispatch(e: Env) -> AgenticProcess:
    # ``tasks/dispatch._run_for`` — mirrored: brief + ownership in ``instructions``.
    return await AgenticProcess(worker_type=e.worker_type, workdir=e.workdir(), pty_mode=False, visible=False,
                                load_flowpad_assistant=True,
                                context_data={"task_id": str(uuid.uuid4()),
                                              "instructions": f"{INSTRUCTIONS}\n\nYou own task t: T.",
                                              "launched_by_agent": ""}).save()


async def _live_session(e: Env) -> AgenticProcess:
    from flow_sdk.app.actions.execute_prompt import _reuse_or_spawn_headless

    process = await _reuse_or_spawn_headless(f"conversation-{uuid.uuid4()}", e.workdir())
    process.worker_type = e.worker_type
    return await process.save()


async def _graph_workflow_agent(e: Env) -> AgenticProcess:
    # ``GraphWorkflowManager`` agent node — mirrored: the node's definition rides the PTY instruction.
    return await AgenticProcess(worker_type=e.worker_type, workdir=e.workdir(), visible=False,
                                context_data={"flow_run_id": "r", "flow_id": "f", "node_id": "n"}).save()


async def _trigger(e: Env) -> AgenticProcess:
    # Legacy schedule trigger (trigger.py) — mirrored.
    return await AgenticProcess(worker_type=e.worker_type, workdir=e.workdir(), visible=False,
                                instruction_content="do it", name="Trigger").save()


async def _project_language(e: Env) -> AgenticProcess:
    project = await e.project(locale="he")
    return await AgenticProcess(worker_type=e.worker_type, workdir=project.fs_storage_mount_path,
                                project_id=project.id, pty_mode=False).save()


async def _project_always_use_skills(e: Env) -> AgenticProcess:
    workdir = Path(e.workdir())
    (workdir / "flow.json").write_text(json.dumps({"always_use_skills": ["help-desk"]}), encoding="utf-8")
    return await AgenticProcess(worker_type=e.worker_type, workdir=str(workdir), pty_mode=False).save()


async def _ts_sdk_script(e: Env) -> AgenticProcess:
    return await e.create_from_app({"output_format": "stream-json", "process_type": "chat"}, surface=False)


async def _app_vibe(e: Env) -> AgenticProcess:
    # use-start-vibe-session.ts: createProcess, then embedVibeSubagent (vibe IS the persona).
    process = await e.create_from_app({"output_format": "stream-json", "process_type": "chat"})
    return await e.embed(process, "vibe.md", as_persona=True)


async def _app_new_chat(e: Env) -> AgenticProcess:
    # open-new-chat.ts (chat view): createProcess, then embedStandardAgent.
    process = await e.create_from_app({"output_format": "stream-json", "process_type": "chat"})
    return await e.embed(process, "standard.md", as_persona=True)


async def _app_new_terminal(e: Env) -> AgenticProcess:
    # open-new-chat.ts (terminal view): a PTY process, no persona.
    return await e.create_from_app({}, pty_mode=True)


async def _app_assistant_chat(e: Env) -> AgenticProcess:
    # AssistantChat.tsx: the page it belongs to rides ``instructions``; no persona.
    return await e.create_from_app({"output_format": "stream-json", "process_type": "chat",
                                    "context_key": f"k-{uuid.uuid4()}", "instructions": INSTRUCTIONS,
                                    "assistant_dock_url": "/dock/x"})


async def _app_wizard(e: Env) -> AgenticProcess:
    # start-wizard-process.ts: contextData.wizard, then the wizard's agent as the persona.
    process = await e.create_from_app({"output_format": "stream-json", "process_type": "chat",
                                       "wizard": {"name": "git-setup"}})
    return await e.embed(process, "git-setup.md", as_persona=True)


async def _app_agent_use(e: Env) -> AgenticProcess:
    # use-agent-launcher.ts: Agent.use (body carries launch_surface), then prepareAgentSession embeds
    # vibe as a LAYER — the agent keeps its identity. auto_open lands what the session opened.
    from flow_sdk.schema.data_spec.dock_pointer_spec import DockPointerSpec

    project = await e.project()
    root = Path(project.fs_storage_mount_path)
    (root / "a.html").write_text("<title>a</title>", encoding="utf-8")
    pointer = f"{project.id}/editor/html/vfs/project-{project.id}/a.html"
    agent = await e.agent(project, auto_open=[DockPointerSpec(viewType="project", pointer=pointer)])
    e.monkeypatch.setattr("flow_sdk.builtin.agent.start_auto_open", lambda *a, **k: None)
    process = await agent.use(launch_surface="app")
    return await e.embed(process, "vibe.md", as_persona=False)


async def _app_auto_launch(e: Env) -> AgenticProcess:
    # agent-auto-launch-redirect.ts: POST /agents/auto-launch {launch_surface}, then prepareAgentSession.
    from flow_sdk.builtin.agent import Agent

    project = await e.project()
    await e.agent(project, auto_launch=True)
    outcome = await Agent.auto_launch_for(project.id, launch_surface="app")
    assert outcome is not None, "the agent auto-launched"
    return await e.embed(outcome.process, "vibe.md", as_persona=False)


ROWS: tuple[Row, ...] = (
    # A user's own ``AgenticProcess(...)`` / ``.run()`` — the SDK surface, no flow_sdk site.
    Row("sdk_process", _sdk_process, (L.COMMON, L.INSTRUCTIONS)),
    Row("sdk_typed_run", _sdk_typed_run, (L.COMMON, L.INSTRUCTIONS, L.IO)),
    Row("cli_process_start", _cli_process_start, (L.COMMON,), sites=("flow_sdk/cli/commands/process_cmd.py",)),
    Row("agent_deployment", _agent_deployment, (L.COMMON, L.INSTRUCTIONS), sites=(
        "flow_sdk/builtin/deployment.py", "flow_sdk/builtin/agent.py", "flow_sdk/builtin/agent_serve.py",
        "flow_sdk/blocks/__init__.py", "flow_sdk/builtin/faas/compute_node.py", "flow_sdk/cli/commands/diagnose_cmd.py",
        "flow_sdk/core/capabilities/registry.py", "flow_sdk/core/compute/process_step.py",
        "flow_sdk/core/entity/entity_model.py", "flow_sdk/migrations/runner.py",
        "flow_sdk/system_projects/flowpad_assistant/agentic-assets/data_driver/agent/transport.py",
    )),
    Row("agent_use_sdk", _agent_use_sdk, (L.COMMON, L.INSTRUCTIONS)),
    Row("chief_of_staff", partial(_agent_deployment, chief_of_staff=True), (L.COMMON, L.INSTRUCTIONS, L.COS_TASKS)),
    Row("task_dispatch", _task_dispatch, (L.COMMON, L.INSTRUCTIONS), sites=("flow_sdk/tasks/dispatch.py",)),
    Row("live_session", _live_session, (L.COMMON,), sites=("flow_sdk/app/actions/execute_prompt.py",)),
    Row("graph_workflow_agent", _graph_workflow_agent, (L.COMMON,),
        sites=("flow_sdk/graph_workflow_manager/manager.py",)),
    Row("trigger", _trigger, (L.COMMON,), sites=("flow_sdk/builtin/trigger.py",)),
    Row("project_language", _project_language, (L.COMMON, L.LANGUAGE)),
    Row("project_always_use_skills", _project_always_use_skills, (L.COMMON, L.ALWAYS_USE_SKILLS)),
    Row("ts_sdk_script", _ts_sdk_script, (L.COMMON,), sites=("flow_sdk/builtin/faas/scan_actions.py",)),
    Row("app_vibe", _app_vibe, (L.COMMON, L.COMMON_UI, L.AGENTS), persona="vibe"),
    Row("app_new_chat", _app_new_chat, (L.COMMON, L.COMMON_UI, L.AGENTS), persona="standard"),
    Row("app_new_terminal", _app_new_terminal, (L.COMMON, L.COMMON_UI)),
    Row("app_assistant_chat", _app_assistant_chat, (L.COMMON, L.COMMON_UI, L.INSTRUCTIONS)),
    Row("app_wizard", _app_wizard, (L.COMMON, L.COMMON_UI, L.AGENTS), persona="git-setup"),
    Row("app_agent_use", _app_agent_use, (L.COMMON, L.COMMON_UI, L.INSTRUCTIONS, L.AGENTS, L.AUTO_OPEN)),
    Row("app_auto_launch", _app_auto_launch, (L.COMMON, L.COMMON_UI, L.INSTRUCTIONS, L.AGENTS)),
)


# ── turn paths: build the real spawn, read the vendor's real channel ────────


def _flag(argv: list[str], flag: str) -> str | None:
    return argv[argv.index(flag) + 1] if flag in argv else None


def channel_text(vendor: str, argv: list[str], env: dict[str, str]) -> str:
    """The system-prompt text exactly as ``vendor`` will read it from this spawn."""
    if vendor == "claude":
        path = _flag(argv, "--append-system-prompt-file")
        return Path(path).read_text(encoding="utf-8") if path else ""
    if vendor == "deepagents":
        path = _flag(argv, "--system-prompt-file")
        return Path(path).read_text(encoding="utf-8") if path else ""
    if vendor == "codex":
        values = [argv[i + 1] for i, a in enumerate(argv[:-1]) if a == "-c" and argv[i + 1].startswith("developer_instructions=")]
        assert len(values) <= 1, "one developer message"
        return tomllib.loads(values[0].replace("developer_instructions=", "v=", 1))["v"] if values else ""
    if vendor == "copilot":
        dirs = [d for d in (env.get("COPILOT_CUSTOM_INSTRUCTIONS_DIRS") or "").split(",") if d]
        files = [Path(d) / ".github" / "instructions" / "flowpad.instructions.md" for d in dirs]
        return "\n\n".join(read_document(f).body for f in files if f.is_file())
    if vendor == "opencode":
        config = env.get("OPENCODE_CONFIG")
        if not config:
            return ""
        listed = json.loads(Path(config).read_text(encoding="utf-8")).get("instructions") or []
        return "\n\n".join(Path(p).read_text(encoding="utf-8") for p in listed)
    raise AssertionError(f"no channel reader for vendor {vendor!r} — add one")


async def _headless_spawn(process: AgenticProcess, monkeypatch) -> tuple[list[str], dict[str, str]]:
    import importlib

    captured: dict = {}

    async def _capture(driver, proc, worker, *, prompt, context, **_kw):
        captured.update(worker=worker, context=context, prompt=prompt)
        return SimpleNamespace(status="SUCCESS")

    module = importlib.import_module(type(process.driver).__module__)
    monkeypatch.setattr(module, "run_headless_turn", _capture)
    await process.driver.headless_prompt(process, "hi")
    assert captured, "headless_prompt reached the worker"
    argv, env, _stdin = captured["worker"]._build_spawn(captured["context"], captured["prompt"])
    return argv, env


async def _inline_spawn(process: AgenticProcess, monkeypatch) -> tuple[list[str], dict[str, str]]:
    if process._should_preassign_session_id():  # as the ``prompt`` action does before the context
        process.session_id = str(uuid.uuid4())
    context = await process._inline_turn_context()
    argv, env, _stdin = process.driver.stream_worker(process)._build_spawn(context, "hi")
    return argv, env


async def _pty_spawn(process: AgenticProcess, monkeypatch) -> tuple[list[str], dict[str, str]]:
    prepared = await process.prepare_process_assets()
    cmd = process._finalized_restart_cli_options()
    process._apply_process_assets(cmd, prepared, str(process.id))
    argv, env, _stdin = cmd.to_spawn("hi")
    return argv, env


PATHS = {"headless": _headless_spawn, "inline": _inline_spawn, "pty": _pty_spawn}


def _paths_for(vendor) -> list[str]:
    return [p for p in PATHS if p != "pty" or vendor.interactive]


def _marker(layer: L, row: Row) -> str:
    if layer is L.AGENTS:
        return PERSONA_HEADER.format(name=row.persona) if row.persona else CATALOGUE_HEADER
    return MARKERS[layer]


def assert_layers(text: str, row: Row, where: str) -> None:
    positions = []
    for layer in row.layers:
        marker = _marker(layer, row)
        count = text.count(marker)
        assert count == 1, f"{where}: layer {layer.value!r} marker {marker!r} appears {count}× in:\n{text}"
        positions.append(text.index(marker))
    assert positions == sorted(positions), f"{where}: layers out of order {row.layers} at {positions}:\n{text}"
    for layer in L:
        if layer in row.layers:
            continue
        markers = [PERSONA_HEADER.format(name="").rstrip("'"), CATALOGUE_HEADER] if layer is L.AGENTS else [MARKERS[layer]]
        for marker in markers:
            assert marker not in text, f"{where}: unexpected layer {layer.value!r} ({marker!r}) in:\n{text}"


CELLS = [pytest.param(row, vendor, id=f"{row.name}-{vendor.key}") for row in ROWS for vendor in VENDORS]


@pytest.mark.parametrize(("row", "vendor"), CELLS)
async def test_cell(row: Row, vendor, tmp_path, monkeypatch, tmp_records_root):
    env = Env(tmp=tmp_path, vendor=vendor.key, worker_type=vendor.worker_type, monkeypatch=monkeypatch)
    process = await row.build(env)
    assert process.driver.name == vendor.key or vendor.key in str(process.worker_type), (
        f"{row.name}: built a {process.worker_type} process for {vendor.key}"
    )

    composed = await process.prepare_system_instruction_assets()
    assert composed.layers == [layer.value for layer in row.layers], f"{row.name}/{vendor.key}: composed layers"

    for path in _paths_for(vendor):
        argv, spawn_env = await PATHS[path](await AgenticProcess.get_by_id(process.id), monkeypatch)
        assert_layers(channel_text(vendor.key, argv, spawn_env), row, f"{row.name}/{vendor.key}/{path}")


# ── coverage guards ──────────────────────────────────────────────────────────


def test_every_layer_is_expected_somewhere():
    expected = {layer for row in ROWS for layer in row.layers}
    assert expected == set(L), f"no row expects {sorted(set(L) - expected)} — add one"


def test_every_vendor_has_a_channel_reader():
    for vendor in VENDORS:
        try:
            channel_text(vendor.key, [], {})
        except AssertionError as exc:
            pytest.fail(str(exc))


def test_app_rows_are_the_only_rows_with_common_ui():
    for row in ROWS:
        assert (L.COMMON_UI in row.layers) == row.name.startswith("app_"), row.name
        assert L.COMMON in row.layers, f"{row.name}: COMMON reaches every process"


_CREATION = re.compile(r"(?<![\w.])AgenticProcess\(|\.create_process\(")


def test_every_creation_site_has_a_row():
    """A file in flow_sdk/ that constructs an AgenticProcess or calls ``create_process`` launches
    processes — it must be one of the rows' ``sites``, or the matrix does not cover it."""
    covered = {site for row in ROWS for site in row.sites}
    found = set()
    for path in (REPO / "flow_sdk").rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        for match in _CREATION.finditer(text):
            line = text[text.rfind("\n", 0, match.start()) + 1:text.find("\n", match.start())]
            if re.match(r"\s*(async\s+)?def |\s*class |\s*#", line):
                continue
            found.add(str(path.relative_to(REPO)))
    assert found - covered == set(), f"process-creation sites with no matrix row: {sorted(found - covered)}"
    assert covered - found == set(), f"rows name sites that no longer create processes: {sorted(covered - found)}"


async def test_the_shipped_layers_load_from_the_wheel_path(monkeypatch):
    """The real files, not the sentinels: both exist, frontmatter is stripped, and COMMON_UI
    carries the chat language rule the personas no longer repeat."""
    monkeypatch.undo()
    common = system_prompt.shipped_layer("common")
    common_ui = system_prompt.shipped_layer("common_ui")
    assert common and not common.startswith("---")
    assert common_ui and "**Language:**" in common_ui and "flow show" in common_ui


async def test_session_adopted_from_the_app_is_an_app_launch(tmp_path, monkeypatch, tmp_records_root):
    """``AgenticProcess.getByWorkerId`` from the app adopts an on-disk session into a terminal —
    a launch, stamped from its query hint. (Its PTY spawn is not under test.)"""
    from flow_sdk.builtin.faas.compute_node import ComputeNode

    monkeypatch.setattr(AgenticProcess, "start_pty", AsyncMock(return_value=None))
    monkeypatch.setattr(AgenticProcess, "start", AsyncMock(return_value=None), raising=False)
    workdir = tmp_path / "w"
    workdir.mkdir()
    resp = await ComputeNode()._upsert_session_process_impl(
        session_id=str(uuid.uuid4()), workdir=str(workdir), project_id=None, worker_type_raw="claude",
        launch_surface="app",
    )
    assert resp.status == "SUCCESS", getattr(resp, "message", resp)
    process = await AgenticProcess.get_by_id(resp.data["id"])
    assert (process.context_data or {}).get("launch_surface") == "app"
    assert (await process.prepare_system_instruction_assets()).layers == ["common", "common_ui"]


def test_a_request_cannot_invent_a_surface():
    assert system_prompt.launch_surface_fields("app") == {"launch_surface": "app"}
    for other in (None, "", "hub", "APP", 1, {"x": 1}):
        assert system_prompt.launch_surface_fields(other) == {}
