"""``flow project setup`` — collect what a project needs, compile an ephemeral wizard, run it.

The collector and compiler are pure; the run is the CLI's own ``_run`` on this test's loop, with
every ``flow credentials …`` the wizard shells out to run through the REAL Typer app (in a thread,
its service calls bridged back onto this loop — the ``flow_runner`` pattern). Nothing but the
shell's process boundary, the terminal and the agent launch is replaced.
``tests/long_tests/test_project_setup_cli.py`` runs the literal ``flow project setup`` against a
real backend.
"""
from __future__ import annotations

import asyncio
import json
import shlex
from pathlib import Path

import pytest
from dotenv import dotenv_values
from typer.testing import CliRunner

from flow_sdk.builtin import credential_service, project_setup
from flow_sdk.builtin.credential_service import CredentialError, save_credential
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.secret_pack import SecretPack
from flow_sdk.cli.commands import credentials_cmd, project_cmd
from flow_sdk.schema.data_spec.credential_spec import CredentialSpec
from flow_sdk.schema.data_spec.project_setup_spec import REQUIREMENT_GAP, REQUIREMENT_OAUTH, REQUIREMENT_PACK
from flow_sdk.schema.data_spec.returned_value_spec import CliResult, PromptResult

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

SHIPPED = Path(project_setup.__file__).parents[1] / "system_projects/flowpad_assistant/agentic-assets/secret_pack"
TOKEN = "123456:telegram-token-never-printed"


def _template(name: str) -> SecretPack:
    """A shipped catalogue entry as the index holds it: a ``system``-scope row."""
    spec = CredentialSpec.model_validate(json.loads((SHIPPED / name / "secret_pack.json").read_text()))
    fields = {f: getattr(spec, f) for f in credential_service._MANIFEST_FIELDS}
    return SecretPack(name=spec.name, scope="system", manifest_schema=spec.manifest_schema, **fields)


@pytest.fixture
def templates(monkeypatch):
    shipped = [_template(n) for n in ("gmail", "openai", "telegram", "twilio")]

    async def catalogue():
        return shipped

    monkeypatch.setattr(credential_service, "shipped_templates", catalogue)
    return shipped


def _sources(monkeypatch, *providers: str) -> None:
    """The project's data sources, one per driver (the drivers are the shipped ones)."""
    rows = [DataSource(name=f"{p} source", provider=p) for p in providers]

    async def of_project(_project):
        return rows

    monkeypatch.setattr(project_setup, "project_sources", of_project)


# ── the spec: every credential says how it is set up ─────────────────────────


async def test_every_shipped_credential_carries_setup_instructions():
    repo_packs = Path(__file__).parents[3] / "agentic-assets/secret_pack"
    folders = [*SHIPPED.iterdir(), *(repo_packs.iterdir() if repo_packs.is_dir() else [])]
    manifests = [json.loads((f / "secret_pack.json").read_text()) for f in folders if (f / "secret_pack.json").is_file()]
    assert manifests
    bare = [m["name"] for m in manifests if not str(m.get("setup") or "").strip()]
    assert bare == [], "a credential Flowpad ships must say how to obtain and store its values"
    for manifest in manifests:
        assert f"flow credentials set {manifest['name']} --stdin" in manifest["setup"], (
            f"{manifest['name']}: a value is piped in, never an argument (argv and the agent's transcript both keep it)"
        )


async def test_a_credential_without_setup_instructions_is_refused(project):
    with pytest.raises(CredentialError, match="setup instructions"):
        await save_credential(manifest={"name": "bare", "vars": {"BARE_KEY": {}}}, scope="project", project_id=project.id)


async def test_a_pack_without_setup_still_loads_and_is_reported_as_having_no_ai_setup(project, templates, monkeypatch):
    spec = await save_credential(manifest={"name": "legacy", "vars": {"LEGACY_KEY": {}}, "setup": "x"},
                                 scope="project", project_id=project.id)
    spec.setup = ""  # a pack written before `setup` existed, as read from disk
    await spec.save()
    _sources(monkeypatch)

    (req,) = await project_setup.collect_requirements(project)

    assert (req.kind, req.name, req.setup) == (REQUIREMENT_PACK, "legacy", "")
    assert "AI setup unavailable" in req.note
    wizard, _ops = project_setup.compile_setup(project.id, [req])
    assert [s.id for s in wizard.steps] == ["ask-legacy-LEGACY_KEY", "store-legacy"], "no AI rung without instructions"


async def test_a_value_that_does_not_match_its_pattern_is_refused(project):
    spec = await save_credential(
        manifest={"name": "pat", "vars": {"PAT_KEY": {"pattern": "^sk-"}}, "setup": "x"},
        scope="project", project_id=project.id,
    )
    with pytest.raises(CredentialError, match="does not look right"):
        await credential_service.set_credential_values(str(spec.typeid), {"PAT_KEY": "nope"})


# ── collect ──────────────────────────────────────────────────────────────────


async def test_the_collector_reads_the_project_and_its_sources_drivers(project, templates, monkeypatch):
    await save_credential(manifest={"name": "stripe", "vars": {"STRIPE_KEY": {"label": "Secret key"}},
                                    "setup": "From the Stripe dashboard."}, scope="project", project_id=project.id)
    _sources(monkeypatch, "gdrive", "gcs", "telegram", "gmail", "voice_phone")

    reqs = await project_setup.collect_requirements(project)
    by = {(r.kind, r.name): r for r in reqs}

    assert [r.kind for r in reqs] == sorted((r.kind for r in reqs), key=[REQUIREMENT_OAUTH, REQUIREMENT_PACK, REQUIREMENT_GAP].index)
    google = by[(REQUIREMENT_OAUTH, "google")]
    assert google.used_by == ["gdrive source", "gcs source"], "one connection, every requester"
    assert set(google.scopes) == {"https://www.googleapis.com/auth/drive.readonly",
                                  "https://www.googleapis.com/auth/devstorage.read_only"}
    assert google.satisfied is None, "only its check can tell"

    stripe = by[(REQUIREMENT_PACK, "stripe")]
    assert stripe.used_by == ["project"] and stripe.declared and [v.env_var for v in stripe.missing] == ["STRIPE_KEY"]
    telegram = by[(REQUIREMENT_PACK, "telegram")]
    assert not telegram.declared and telegram.setup and telegram.used_by == ["telegram source"], "a driver's credential"
    assert by[(REQUIREMENT_PACK, "gmail")].used_by == ["gmail source"], "env names → the template declaring them"
    assert by[(REQUIREMENT_PACK, "twilio")].used_by == ["voice_phone source"]
    assert by[(REQUIREMENT_PACK, "openai")].used_by == ["voice_phone source"], "one source may span several credentials"
    gap = by[(REQUIREMENT_GAP, "voice_phone source")]
    assert "OPENAI_WEBHOOK_SECRET" in gap.note and "TWILIO" not in gap.note


async def test_a_credential_with_its_values_is_ready(project, templates, monkeypatch):
    await save_credential(manifest={"name": "stripe", "vars": {"STRIPE_KEY": {}}, "setup": "x"},
                          scope="project", project_id=project.id, values={"STRIPE_KEY": "sk_live"})
    _sources(monkeypatch)

    (req,) = await project_setup.collect_requirements(project)

    assert req.satisfied and req.missing == []


# ── compile ──────────────────────────────────────────────────────────────────


async def test_a_credential_compiles_to_ask_store_then_ai_on_one_check(project, templates, monkeypatch):
    _sources(monkeypatch, "telegram", "gdrive")
    reqs = await project_setup.collect_requirements(project)

    wizard, ops = project_setup.compile_setup(project.id, reqs)

    assert [s.id for s in wizard.steps] == [
        "connect-google", "ask-telegram-TELEGRAM_BOT_TOKEN", "store-telegram", "ai-telegram",
    ]
    assert {s.on_fail for s in wizard.steps} == {"continue"}, "one credential nobody can provide stops nothing"
    ask = ops["ask-telegram-TELEGRAM_BOT_TOKEN"]
    assert ask.exe_data.secret and ask.completion_check is None
    assert wizard.steps[1].bind == "telegram__TELEGRAM_BOT_TOKEN"
    store, ai = ops["store-telegram"], ops["ai-telegram"]
    assert store.completion_check == ai.completion_check, "the AI rung skips itself when the key step got there"
    assert "credentials check telegram --project" in store.completion_check.command_for("linux")
    assert ai.exe_data.agent == "provisioner" and ai.setup == reqs[1].setup
    assert "credentials test" not in ops["connect-google"].completion_check.command_for("linux")
    assert "connections test google --scope" in ops["connect-google"].completion_check.command_for("linux")

    no_ai, _ = project_setup.compile_setup(project.id, reqs, ai=False)
    assert "ai-telegram" not in [s.id for s in no_ai.steps]


# ── run: `flow project setup`, its shell bridged into the real CLI ───────────


@pytest.fixture
async def cli(monkeypatch, project):
    """The wizard's shell runs `flow …` through the real Typer app; the terminal answers from a list."""
    from flow_sdk.cli import flow_cli

    loop = asyncio.get_running_loop()
    monkeypatch.setattr(credentials_cmd, "discover_port", lambda required=True: None)
    monkeypatch.setattr(credentials_cmd, "_here", lambda coro: asyncio.run_coroutine_threadsafe(coro, loop).result())
    ran: list[list[str]] = []

    def invoke(argv: list[str], env: dict, stdin: str = "") -> CliResult:
        ran.append(argv)
        said = CliRunner().invoke(flow_cli.app, argv, env=env, input=stdin)
        return CliResult(exit_code=0 if said.exit_code == 0 else 1, returncode=said.exit_code,
                         stdout=said.stdout, stderr=getattr(said, "stderr", ""))

    async def shell(command, *, timeout_seconds, workdir, extra_env=None, platform=""):
        argv = shlex.split(command)
        argv = argv[argv.index("flow_sdk.cli.flow_cli") + 1:]
        return await asyncio.to_thread(invoke, argv, dict(extra_env or {}))

    answers: list[str] = []
    asked: list[tuple[str, bool]] = []

    def read(prompt: str, secret: bool) -> str:
        asked.append((prompt, secret))
        return answers.pop(0) if answers else ""

    monkeypatch.setattr(project_cmd, "_shell", shell)
    monkeypatch.setattr(project_cmd, "_read", read)
    return {"answers": answers, "asked": asked, "ran": ran, "invoke": invoke}


def _env_file(project) -> dict:
    return dict(dotenv_values(Path(project.fs_storage_mount_path) / ".env.local"))


async def test_a_typed_key_is_stored_never_printed_and_a_rerun_skips_it(project, templates, cli, monkeypatch, capsys):
    _sources(monkeypatch, "telegram")
    cli["answers"].append(TOKEN)

    code = await project_cmd._run(project.id, dry_run=False, ai=True, as_json=False)
    out = capsys.readouterr()

    assert code == 0, out.out
    assert _env_file(project)["TELEGRAM_BOT_TOKEN"] == TOKEN, "declared from its template, value in the project"
    assert TOKEN not in out.out + out.err, "a value is never printed"
    assert cli["asked"] == [(cli["asked"][0][0], True)] and "Telegram" in cli["asked"][0][0]
    assert "Bot token: answered" in out.out and "✓  Store Telegram bot: done" in out.out and "AI setup: Telegram bot: already done" in out.out
    assert all(TOKEN not in " ".join(argv) for argv in cli["ran"]), "the value travels as env, never argv"

    cli["asked"].clear()
    again = await project_cmd._run(project.id, dry_run=False, ai=True, as_json=True)
    result = json.loads(capsys.readouterr().out.strip().splitlines()[-1])

    assert again == 0 and result["ok"] and cli["asked"] == [], "a re-run asks nothing"


async def test_an_empty_answer_hands_the_credential_to_the_ai_setup(project, templates, cli, monkeypatch, capsys):
    _sources(monkeypatch, "telegram")
    prompts: list[dict] = []

    async def agent(**call):
        """The provisioner, doing what its instructions say: pipe the value into the store command."""
        prompts.append(call)
        stored = await asyncio.to_thread(cli["invoke"], ["credentials", "set", "telegram", "--project", project.id,
                                                          "--stdin"], {}, f"TELEGRAM_BOT_TOKEN={TOKEN}\n")
        assert stored.ok, stored.stdout
        return PromptResult.satisfied("stored it", text="Stored the bot token.")

    monkeypatch.setattr(project_cmd, "_launch", agent)

    code = await project_cmd._run(project.id, dry_run=False, ai=True, as_json=False)
    out = capsys.readouterr().out

    assert code == 0, out
    (call,) = prompts
    assert call["agent"] == "provisioner"
    assert "@BotFather" in call["prompt"], "the credential's own setup instructions"
    assert "never print" in call["prompt"].lower() and f"--project {project.id} --stdin" in call["prompt"]
    assert "VAR=<value>" not in call["prompt"], "the store command never takes a value as an argument"
    assert all(TOKEN not in " ".join(argv) for argv in cli["ran"]), "the agent's value never reached an argv"
    assert "left empty" in out and "✗  Store Telegram bot: the cli call ran" in out
    assert "✓  AI setup: Telegram bot: done" in out
    assert _env_file(project)["TELEGRAM_BOT_TOKEN"] == TOKEN


async def test_without_ai_an_empty_answer_leaves_it_missing_and_says_so(project, templates, cli, monkeypatch, capsys):
    _sources(monkeypatch, "telegram")

    async def never(**_call):
        raise AssertionError("--no-ai launched an agent")

    monkeypatch.setattr(project_cmd, "_launch", never)

    code = await project_cmd._run(project.id, dry_run=False, ai=False, as_json=False)
    out = capsys.readouterr().out

    assert code == 1
    assert "AI setup" not in out and "Not set up yet: telegram" in out
    assert "Leave it empty" not in cli["asked"][0][0], "no AI rung, so no offer of one"


async def test_dry_run_lists_and_changes_nothing(project, templates, cli, monkeypatch, capsys):
    _sources(monkeypatch, "telegram", "gdrive", "voice_phone")

    code = await project_cmd._run(project.id, dry_run=True, ai=True, as_json=True)
    listed = json.loads(capsys.readouterr().out.strip().splitlines()[-1])

    assert code == 0 and cli["ran"] == [] and cli["asked"] == []
    assert [(r["kind"], r["name"], r["state"]) for r in listed["requirements"]][:2] == [
        ("oauth", "google", "checked when run"), ("pack", "telegram", "missing TELEGRAM_BOT_TOKEN"),
    ]
    assert any(r["kind"] == "gap" for r in listed["requirements"])


async def test_the_documented_commands_are_real():
    """`docs/snippets/secret-stores.md` § 7 — every line is a command this CLI parses."""
    from flow_sdk.cli import flow_cli
    from tests.utils.snippets import doc, fence_under

    lines = [ln.split("#")[0].split() for ln in fence_under(doc("secret-stores.md"), "7. Set up a project", lang="bash").splitlines()]
    commands = [ln for ln in lines if ln and ln[0] == "flow"]
    assert len(commands) == 8
    for argv in commands:
        said = CliRunner().invoke(flow_cli.app, [*argv[1:], "--help"])
        assert said.exit_code == 0, (argv, said.output)


# ── declare / set --stdin: the public surface a project and an agent use ─────

DEMO = {
    "name": "demo-service", "title": "Demo service",
    "vars": {"DEMO_API_KEY": {"label": "API key", "pattern": "^demo_[0-9a-f]{32}$"},
             "DEMO_ENDPOINT": {"label": "Endpoint", "pattern": "^https?://", "secret": False}},
    "setup": "Generate DEMO_API_KEY, read DEMO_ENDPOINT from service.url; pipe both into "
             "`flow credentials set demo-service --stdin`.",
}
DEMO_KEY = "demo_" + "0123456789abcdef" * 2


def _manifest(tmp_path, body: dict) -> str:
    path = tmp_path / f"{body.get('name', 'x')}.json"
    path.write_text(json.dumps(body))
    return str(path)


async def test_declare_puts_the_credential_in_the_project_and_twice_is_once(project, cli, tmp_path):
    first = await asyncio.to_thread(cli["invoke"], ["credentials", "declare", _manifest(tmp_path, DEMO), "--project", project.id], {})
    assert first.ok, first.stdout
    folder = Path(project.fs_storage_mount_path) / "agentic-assets/secret_pack/demo-service"
    assert json.loads((folder / "secret_pack.json").read_text())["vars"].keys() == DEMO["vars"].keys()

    again = await asyncio.to_thread(cli["invoke"], ["credentials", "declare", _manifest(tmp_path, {**DEMO, "title": "Demo 2"}),
                                                    "--project", project.id], {})
    assert again.ok, again.stdout
    assert json.loads(again.stdout)["typeid"] == json.loads(first.stdout)["typeid"], "updated in place, not a twin"
    assert json.loads((folder / "secret_pack.json").read_text())["title"] == "Demo 2"


async def test_declare_refuses_a_credential_that_does_not_say_how_it_is_set_up(project, cli, tmp_path):
    bare = {k: v for k, v in DEMO.items() if k != "setup"}
    said = await asyncio.to_thread(cli["invoke"], ["credentials", "declare", _manifest(tmp_path, bare), "--project", project.id], {})
    assert not said.ok and "setup instructions" in said.stdout + said.stderr
    assert not (Path(project.fs_storage_mount_path) / "agentic-assets/secret_pack/demo-service").exists()


async def test_set_stdin_stores_checks_the_pattern_and_prints_no_value(project, cli, tmp_path):
    assert (await asyncio.to_thread(cli["invoke"], ["credentials", "declare", _manifest(tmp_path, DEMO), "--project", project.id], {})).ok

    wrong = await asyncio.to_thread(cli["invoke"], ["credentials", "set", "demo-service", "--project", project.id, "--stdin"],
                                    {}, "DEMO_API_KEY=not-a-demo-key\n")
    assert not wrong.ok, "a value off its pattern is refused at the write"
    assert "DEMO_API_KEY" not in _env_file(project)

    stored = await asyncio.to_thread(cli["invoke"], ["credentials", "set", "demo-service", "--project", project.id, "--stdin"],
                                     {}, f"# the key\nDEMO_API_KEY={DEMO_KEY}\n\nDEMO_ENDPOINT=https://demo.test/api\n")
    assert stored.ok, stored.stdout
    assert json.loads(stored.stdout)["stored"] == ["DEMO_API_KEY", "DEMO_ENDPOINT"]
    assert DEMO_KEY not in stored.stdout
    assert _env_file(project) == {"DEMO_API_KEY": DEMO_KEY, "DEMO_ENDPOINT": "https://demo.test/api"}

    check = await asyncio.to_thread(cli["invoke"], ["credentials", "check", "demo-service", "--project", project.id], {})
    assert check.ok and json.loads(check.stdout)["ready"], check.stdout
