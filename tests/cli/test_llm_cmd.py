"""``flow llm`` — the terminal face of the LLM source picker.

The CLI owns exactly two jobs: turning the status dict into a numbered list, and turning a
chosen row into something a shell can evaluate. Both are pure, so most of this file drives
them directly. The registration and the route contract are checked against the real app, the
same way ``test_progress_cmd.py`` does it — a CLI that formats perfectly and posts to the
wrong verb is still broken.
"""

from __future__ import annotations

import json
import shlex

import pytest
import typer
from typer.testing import CliRunner

from flow_sdk.cli.commands import llm_cmd
from flow_sdk.cli.flow_cli import app

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

runner = CliRunner()

EP = "llm_endpoint:ep1"
DEVICE = "llm_endpoint:dev-claude"

# One shared endpoint offered to claude and codex, plus a claude-only device login. The
# device login outranks nothing: `rank` is what orders the list, and the picker's own order
# is what the numbering has to reproduce.
STATUS = {
    "sources": {
        "harness.claude.cli": [
            {"endpoint_typeid": EP, "name": "team pool", "rank": 0, "eligible": True, "auto": True},
            {"endpoint_typeid": DEVICE, "name": "claude device login", "rank": 5, "eligible": True, "auto": True},
        ],
        "harness.codex.cli": [
            {"endpoint_typeid": EP, "name": "team pool", "rank": 0, "eligible": True, "auto": True},
        ],
    },
    # ``unverified: False`` because this fixture is a HEALTHY box answered by a CURRENT
    # backend — the flag is part of every verdict such a backend publishes. Leaving it out
    # would quietly make the whole fixture test the older-backend path instead.
    "resolved": {
        "harness.claude.cli": {"endpoint_typeid": EP, "origin": "user", "unverified": False},
        "harness.codex.cli": {"endpoint_typeid": EP, "origin": "user", "unverified": False},
    },
    "endpoints": {
        EP: {"kind": "hub", "provider": "openrouter"},
        DEVICE: {"kind": "device", "provider": ""},
    },
}


# ------------------------------------------------------------------ the list


def test_rows_are_numbered_in_the_pickers_own_order():
    rows = llm_cmd._rows(STATUS)

    assert [(row.n, row.name) for row in rows] == [(1, "team pool"), (2, "claude device login")]


def test_a_source_offered_to_two_harnesses_is_one_row():
    rows = llm_cmd._rows(STATUS)

    assert rows[0].harnesses == ["claude", "codex"]
    assert rows[1].harnesses == ["claude"]


def test_active_comes_from_the_resolver_not_from_auto():
    """``auto`` says a source MAY be chosen silently; ``resolved`` says which one WAS. The
    device login is auto-eligible here and must still not be marked active."""
    rows = llm_cmd._rows(STATUS)

    assert rows[0].active_for == ["claude", "codex"]
    assert rows[1].active_for == []


def test_the_scope_column_is_the_winners_origin():
    rows = llm_cmd._rows(STATUS)

    assert rows[0].scope == "user"
    assert rows[1].scope == ""


def test_a_hub_endpoint_is_offered_to_select_as_kind_endpoint():
    """``LLMEndpointKind.HUB`` is spelled ``endpoint`` by ``select_llm_source``. Getting this
    wrong writes a preference nothing matches."""
    rows = llm_cmd._rows(STATUS)

    assert rows[0].kind == "endpoint"
    assert rows[1].kind == "device"


def test_an_empty_box_renders_a_sentence_rather_than_an_empty_table(capsys):
    llm_cmd._render([])

    assert "No LLM sources" in capsys.readouterr().out


# ------------------------------------------------------------------ picking


def test_a_row_can_be_named_by_number_id_or_name_prefix():
    rows = llm_cmd._rows(STATUS)

    assert llm_cmd._pick(rows, "1").typeid == EP
    assert llm_cmd._pick(rows, EP).typeid == EP
    assert llm_cmd._pick(rows, "team").typeid == EP


def test_an_out_of_range_number_says_what_the_range_is():
    with pytest.raises(typer.Exit):
        llm_cmd._pick(llm_cmd._rows(STATUS), "9")


def test_an_ambiguous_prefix_is_refused_rather_than_guessed():
    rows = [row._replace(name="team pool") if row.n == 2 else row for row in llm_cmd._rows(STATUS)]

    with pytest.raises(typer.Exit):
        llm_cmd._pick(rows, "team")


def test_all_means_every_harness_that_offers_the_source():
    """Not every harness on the box: writing the device login to codex would fail, and the
    user asked for "all" meaning "everywhere this works"."""
    rows = llm_cmd._rows(STATUS)

    assert llm_cmd._targets(rows[1], "all", rows) == ["claude"]
    assert llm_cmd._targets(rows[0], "all", rows) == ["claude", "codex"]


def test_naming_a_harness_the_source_does_not_serve_is_refused():
    rows = llm_cmd._rows(STATUS)

    with pytest.raises(typer.Exit):
        llm_cmd._targets(rows[1], "codex", rows)


# ------------------------------------------------------------------ the shell


@pytest.fixture
def shell_dir(monkeypatch, tmp_path):
    monkeypatch.setattr(llm_cmd, "_shell_dir", lambda worker: tmp_path / worker)
    return tmp_path


def test_an_env_configured_harness_is_exports_alone(shell_dir, capsys):
    binding = {"harnesses": {"claude": {"env": {"ANTHROPIC_BASE_URL": "http://hub/invoke"}, "files": {}}}}

    llm_cmd._emit_exports(binding, ["claude"])

    # ``shlex.quote`` leaves a shell-safe value bare; what matters is that it round-trips.
    assert capsys.readouterr().out.strip() == "export ANTHROPIC_BASE_URL=http://hub/invoke"


def test_codex_gets_a_file_and_a_pointer_at_its_directory(shell_dir, capsys):
    """codex ignores every base-URL variable, so the redirect only lands through
    ``CODEX_HOME`` — and ``CODEX_HOME`` names the DIRECTORY holding ``config.toml``."""
    binding = {
        "harnesses": {
            "codex": {
                "env": {"FLOWPAD_HUB_API_KEY": "k"},
                "files": {"config.toml": 'model = "openai/gpt-5-mini"\n'},
                "pointer_env": "CODEX_HOME",
                "pointer_is_dir": True,
            }
        }
    }

    llm_cmd._emit_exports(binding, ["codex"])

    out = capsys.readouterr().out
    assert f"export CODEX_HOME={shell_dir / 'codex'}" in out
    assert (shell_dir / "codex" / "config.toml").read_text() == 'model = "openai/gpt-5-mini"\n'


def test_opencode_gets_a_pointer_at_the_file_itself(shell_dir, capsys):
    binding = {
        "harnesses": {
            "opencode": {
                "env": {},
                "files": {"opencode.json": "{}\n"},
                "pointer_env": "OPENCODE_CONFIG",
                "pointer_is_dir": False,
            }
        }
    }

    llm_cmd._emit_exports(binding, ["opencode"])

    assert f"export OPENCODE_CONFIG={shell_dir / 'opencode' / 'opencode.json'}" in capsys.readouterr().out


def test_a_device_login_says_so_instead_of_exporting_nothing(shell_dir, capsys):
    """An empty env block reads like a failure. The vendor CLI holds its own credentials."""
    llm_cmd._emit_exports({"harnesses": {"claude": {"device": True, "name": "claude login"}}}, ["claude"])

    out = capsys.readouterr().out
    assert out.startswith("# claude:")
    assert not [line for line in out.splitlines() if line.startswith("export ")]


def test_a_harness_that_cannot_use_the_source_carries_the_resolvers_sentence(shell_dir, capsys):
    binding = {"harnesses": {"codex": {"reason": "codex cannot use provider 'anthropic'"}}}

    llm_cmd._emit_exports(binding, ["codex"])

    assert "# codex: codex cannot use provider 'anthropic'" in capsys.readouterr().out


def test_a_value_with_a_quote_survives_the_shell(shell_dir, capsys):
    """These values carry a bearer token, so a value needing quoting must come back out intact
    after the shell has parsed it."""
    nasty = "tok'; echo pwned #"
    llm_cmd._emit_exports({"harnesses": {"claude": {"env": {"ANTHROPIC_AUTH_TOKEN": nasty}, "files": {}}}}, ["claude"])

    # One arm, and the true one: a shell parses the line into exactly two words, the second
    # carrying the token verbatim. The compound `or` this replaces had an always-false first arm,
    # so only the second was ever doing any work.
    line = capsys.readouterr().out.strip()
    assert shlex.split(line) == ["export", f"ANTHROPIC_AUTH_TOKEN={nasty}"]


# ------------------------------------------------------------------ the route


class _Recorder:
    """Stands in for the local backend and remembers what the CLI asked it.

    The point is the CONTRACT, not the transport: which path, which verb, which payload.
    A CLI that renders perfectly and posts to the wrong sub-action is still broken, and the
    real route is exercised against the same shapes in ``tests/api/test_llm_endpoint_action``.
    """

    def __init__(self, data):
        self.data = data
        self.calls: list[tuple[str, str, dict]] = []

    def __call__(self, method, url, **kwargs):
        self.calls.append((method, url.split("/api/v1", 1)[-1], kwargs.get("json") or kwargs.get("params") or {}))

        class Response:
            status_code = 200

            @staticmethod
            def json():
                return {"status": "SUCCESS", "data": self.data}

        return Response()


@pytest.fixture
def recorder(monkeypatch):
    rec = _Recorder(STATUS)
    monkeypatch.setattr(llm_cmd, "_local_request", lambda method, url, **kw: rec(method, url, **kw))
    monkeypatch.setattr(llm_cmd, "_backend_port", lambda: 9999)
    return rec


def test_the_command_is_registered():
    result = runner.invoke(app, ["llm", "--help"])

    assert result.exit_code == 0
    for sub in ("list", "use", "clear", "test", "user", "project"):
        assert sub in result.output


def test_the_scopes_are_subgroups_not_flags():
    """``flow llm user use N`` and ``flow llm project use N`` — the grammar is positional."""
    for scope in ("user", "project"):
        result = runner.invoke(app, ["llm", scope, "--help"])
        assert result.exit_code == 0, result.output
        assert "use" in result.output and "clear" in result.output


def test_bare_flow_llm_lists(recorder):
    result = runner.invoke(app, ["llm"])

    assert result.exit_code == 0, result.output
    assert "team pool" in result.output
    assert ("GET", "/graph/compute_node/@local/llm-endpoint") in [call[:2] for call in recorder.calls]


def test_list_inside_a_project_asks_the_projects_question(recorder):
    """A project pin outranks the box, so a box-wide listing would name the wrong winner and
    leave SCOPE empty — the same blind spot ``LLMScope`` closed for the UI picker."""
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(llm_cmd, "_project_for_cwd", lambda required=True: "proj-1")
        result = runner.invoke(app, ["llm", "list"])

    assert result.exit_code == 0, result.output
    status = next(call for call in recorder.calls if call[1].endswith("/llm-endpoint"))
    assert status[2] == {"project_id": "proj-1"}


def test_list_outside_a_project_still_works(recorder):
    """``required=False``: the listing is BETTER in a project and must not need one."""
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(llm_cmd, "_project_for_cwd", lambda required=True: "")
        result = runner.invoke(app, ["llm", "list"])

    assert result.exit_code == 0, result.output
    assert "team pool" in result.output


def test_list_marks_the_active_row_and_names_the_harnesses(recorder):
    result = runner.invoke(app, ["llm", "list"])

    assert result.exit_code == 0, result.output
    active = [line for line in result.output.splitlines() if "<- active" in line]
    assert len(active) == 1 and "team pool" in active[0]


def test_shell_use_reads_the_binding_and_never_writes(recorder):
    """Shell scope is the default and must not touch the box: a GET, and no ``select``."""
    recorder.data = {"harnesses": {"claude": {"env": {"ANTHROPIC_BASE_URL": "http://hub"}, "files": {}}}}
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(llm_cmd, "_status", lambda project_id="": STATUS)
        result = runner.invoke(app, ["llm", "use", "1", "claude"])

    assert result.exit_code == 0, result.output
    assert "export ANTHROPIC_BASE_URL=http://hub" in result.output
    # A POST, because it hands back a credential -- but it still writes nothing on the box.
    assert [call[0] for call in recorder.calls] == ["POST"]
    assert recorder.calls[0][1].endswith("/llm-endpoint/binding")
    assert recorder.calls[0][2]["harness"] == "claude"


def test_user_use_posts_select_once_per_harness(recorder):
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(llm_cmd, "_status", lambda project_id="": STATUS)
        result = runner.invoke(app, ["llm", "user", "use", "1"])

    assert result.exit_code == 0, result.output
    posts = [call for call in recorder.calls if call[1].endswith("/select")]
    assert [call[1] for call in posts] == ["/graph/compute_node/@local/llm-endpoint/select"] * 2
    assert [call[2]["harness"] for call in posts] == ["claude", "codex"]
    assert posts[0][2] == {"harness": "claude", "kind": "endpoint", "scope": "user", "endpoint_typeid": EP}


def test_user_use_narrowed_to_one_harness_writes_once(recorder):
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(llm_cmd, "_status", lambda project_id="": STATUS)
        result = runner.invoke(app, ["llm", "user", "use", "1", "codex"])

    assert result.exit_code == 0, result.output
    assert [call[2]["harness"] for call in recorder.calls if call[1].endswith("/select")] == ["codex"]


def test_user_clear_is_the_unbind_verb(recorder):
    """The UI unbinds with DELETE on the bare action; the CLI must not invent a sub-path."""
    recorder.data = {"was_bound": True}
    result = runner.invoke(app, ["llm", "user", "clear"])

    assert result.exit_code == 0, result.output
    assert ("DELETE", "/graph/compute_node/@local/llm-endpoint", {}) in recorder.calls


def test_user_clear_reads_what_it_wrote_before_dropping_the_binding(recorder):
    """The box-wide specs are derived FROM the bound endpoint, so once it is gone there is
    nothing left to say which leaves were ours. Order matters: read, then unbind."""
    recorder.data = {"was_bound": True, "endpoint_typeid": EP}

    result = runner.invoke(app, ["llm", "user", "clear"])

    assert result.exit_code == 0, result.output
    verbs = [call[0] for call in recorder.calls]
    assert verbs.index("DELETE") > verbs.index("GET")


def test_project_use_names_the_project_and_the_scope(recorder):
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(llm_cmd, "_status", lambda project_id="": STATUS)
        mp.setattr(llm_cmd, "_project_for_cwd", lambda: "proj-1")
        result = runner.invoke(app, ["llm", "project", "use", "1"])

    assert result.exit_code == 0, result.output
    post = next(call for call in recorder.calls if call[0] == "POST")
    assert post[2] == {"scope": "project", "project_id": "proj-1", "endpoint_typeid": EP, "kind": "endpoint"}


def test_project_clear_unpins_by_sending_no_endpoint(recorder):
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(llm_cmd, "_project_for_cwd", lambda: "proj-1")
        result = runner.invoke(app, ["llm", "project", "clear"])

    assert result.exit_code == 0, result.output
    post = next(call for call in recorder.calls if call[0] == "POST")
    assert post[2] == {"scope": "project", "project_id": "proj-1"}


def test_clear_derives_the_variables_from_the_harness_specs(recorder):
    """The names are the harnesses' business, so the CLI holds no list of its own — and they are
    a CONSTANT, so it asks nobody: no server, no hub refresh, no credential route."""
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import managed_env_vars

    result = runner.invoke(app, ["llm", "clear"])

    assert result.exit_code == 0, result.output
    unset = [line.split()[1] for line in result.output.splitlines() if line.startswith("unset ")]
    assert unset == list(managed_env_vars())
    assert {"ANTHROPIC_BASE_URL", "CODEX_HOME", "OPENCODE_CONFIG"} <= set(unset)
    assert recorder.calls == []


def test_a_source_the_box_does_not_have_is_refused_before_any_write(recorder):
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(llm_cmd, "_status", lambda project_id="": STATUS)
        result = runner.invoke(app, ["llm", "user", "use", "9"])

    assert result.exit_code == 2, result.output
    assert not [call for call in recorder.calls if call[0] == "POST"]


def test_the_numbering_does_not_move_when_a_project_pins_something(recorder):
    """``list`` asks the project's question and ``use`` asks the box's, so "2" has to mean the
    same row in both. It does because the numbering is built from the un-overlaid OFFER list:
    a pin changes ``resolved``/``blocked``, never ``sources``."""
    pinned = {
        **STATUS,
        "resolved": {
            "harness.claude.cli": {"endpoint_typeid": DEVICE, "origin": "project"},
            "harness.codex.cli": None,
        },
        "blocked": {"harness.codex.cli": "this project requires hub endpoint ..."},
    }

    assert [(row.n, row.typeid) for row in llm_cmd._rows(pinned)] == [
        (row.n, row.typeid) for row in llm_cmd._rows(STATUS)
    ]


# ── transport: HTTP when a backend is up, in-process when not ────────────────


def test_with_no_backend_the_same_function_is_called_directly(monkeypatch):
    """A pure-CLI box (`pip install`, `flow auth login`, `flow llm set`) starts no server. The
    fallback must reach the SAME function, not a CLI-local reimplementation of it."""
    seen = {}

    async def fake_status(project_id=""):
        seen["project_id"] = project_id
        return STATUS

    monkeypatch.setattr(llm_cmd, "_backend_port", lambda: None)
    monkeypatch.setattr(
        "flow_sdk.builtin.agentic_process.cli_drivers.hub_endpoint_binding.hub_llm_endpoint_status", fake_status
    )
    monkeypatch.setattr(llm_cmd, "_project_for_cwd", lambda required=True: "")

    result = runner.invoke(app, ["llm", "list"])

    assert result.exit_code == 0, result.output
    assert "team pool" in result.output
    assert seen == {"project_id": ""}


def test_with_no_backend_a_refusal_still_carries_the_backends_sentence(monkeypatch):
    from flow_sdk.builtin.agentic_process.cli_drivers.hub_endpoint_binding import HubEndpointBindError

    async def refuse(payload):
        raise HubEndpointBindError("this box is not logged in to the hub", 409)

    monkeypatch.setattr(llm_cmd, "_backend_port", lambda: None)
    monkeypatch.setattr(llm_cmd, "_status", lambda project_id="": STATUS)
    monkeypatch.setattr("flow_sdk.builtin.agentic_process.cli_drivers.hub_endpoint_binding.llm_binding", refuse)

    result = runner.invoke(app, ["llm", "set", "1"])

    assert result.exit_code == 6, result.output
    assert "not logged in to the hub" in result.output


def test_project_scope_says_it_needs_an_instance_rather_than_no_project(monkeypatch):
    """Project scope is the one scope that needs the graph. "No project mounts here" would send
    the user hunting for the wrong thing."""
    monkeypatch.setattr(llm_cmd, "_backend_port", lambda: None)

    result = runner.invoke(app, ["llm", "project", "use", "1"])

    assert result.exit_code == 4, result.output
    assert "needs a running instance" in result.output


def test_set_is_an_alias_of_use(recorder):
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(llm_cmd, "_status", lambda project_id="": STATUS)
        used = runner.invoke(app, ["llm", "use", "1", "claude"])
        recorder.calls.clear()
        aliased = runner.invoke(app, ["llm", "set", "1", "claude"])

    assert used.exit_code == 0 and aliased.exit_code == 0
    assert used.output == aliased.output


# ── user scope writes the harness's own config ───────────────────────────────


def test_a_json_merge_keeps_settings_the_user_wrote(tmp_path, monkeypatch):
    """``~/.claude/settings.json`` is a file people hand-edit, and our variables share the
    ``env`` block with theirs. Writing must not eat them."""
    monkeypatch.setattr(llm_cmd.Path, "home", staticmethod(lambda: tmp_path))
    settings = tmp_path / ".claude/settings.json"
    settings.parent.mkdir(parents=True)
    settings.write_text(json.dumps({"theme": "dark", "env": {"MY_OWN": "keep"}}))

    llm_cmd._write_user_config("claude", {"fmt": "json", "path": ".claude/settings.json", "merge": {"env": {"A": "1"}}})

    assert json.loads(settings.read_text()) == {"theme": "dark", "env": {"MY_OWN": "keep", "A": "1"}}


def test_clearing_removes_our_leaves_and_nothing_else(tmp_path, monkeypatch):
    """...and clearing gives the file back as if we had never written. Popping the whole ``env``
    block would take the user's variables with it."""
    monkeypatch.setattr(llm_cmd.Path, "home", staticmethod(lambda: tmp_path))
    settings = tmp_path / ".claude/settings.json"
    settings.parent.mkdir(parents=True)
    settings.write_text(json.dumps({"theme": "dark", "env": {"MY_OWN": "keep", "A": "1"}}))

    spec = {"fmt": "json", "path": ".claude/settings.json", "merge": {"env": {"A": "1"}}}
    llm_cmd._write_user_config("claude", spec, remove=True)

    assert json.loads(settings.read_text()) == {"theme": "dark", "env": {"MY_OWN": "keep"}}

    # ...and with nothing of the user's left in it, the container goes too rather than lingering
    # as an empty block.
    settings.write_text(json.dumps({"env": {"A": "1"}}))
    llm_cmd._write_user_config("claude", spec, remove=True)
    assert json.loads(settings.read_text()) == {}


def test_a_managed_block_rewrites_only_its_own_region(tmp_path, monkeypatch):
    """A ``config.toml`` or a ``.profile`` belongs to the user; only what is between the markers
    is ours. Re-running must replace that region, not append a second copy."""
    monkeypatch.setattr(llm_cmd.Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.setenv("SHELL", "/bin/sh")
    profile = tmp_path / ".profile"
    profile.write_text("export PATH=/mine\n")
    spec = {"fmt": "profile", "path": ".profile", "lines": ["export A=1"]}

    llm_cmd._write_user_config("copilot", spec)
    llm_cmd._write_user_config("copilot", {**spec, "lines": ["export A=2"]})

    body = profile.read_text()
    assert "export PATH=/mine" in body
    assert body.count("export A=") == 1 and "export A=2" in body

    llm_cmd._write_user_config("copilot", spec, remove=True)
    assert profile.read_text().strip() == "export PATH=/mine"


def test_a_harness_with_no_config_file_says_so(tmp_path, monkeypatch):
    monkeypatch.setattr(llm_cmd.Path, "home", staticmethod(lambda: tmp_path))

    line = llm_cmd._write_user_config("nope", {"note": "nope cannot be configured box-wide"})

    assert "cannot be configured box-wide" in line


def test_the_managed_toml_block_goes_first_so_its_keys_stay_root_level(tmp_path, monkeypatch):
    """codex's config is dotted-key TOML, and a real ``~/.codex/config.toml`` commonly ends
    inside a table. Appending our region there re-parents every key under that table — silently,
    with no error and no funding. TOML cannot return to the root, so first is the only safe
    place."""
    monkeypatch.setattr(llm_cmd.Path, "home", staticmethod(lambda: tmp_path))
    config = tmp_path / ".codex/config.toml"
    config.parent.mkdir(parents=True)
    config.write_text('[tui]\ntheme = "dark"\n')

    llm_cmd._write_user_config(
        "codex",
        {"fmt": "block", "path": ".codex/config.toml", "lines": ['model_provider = "flowpad"']},
    )

    body = config.read_text()
    assert body.index("model_provider") < body.index("[tui]"), "our key landed under [tui]"
    assert 'theme = "dark"' in body


def test_the_profile_is_the_one_the_users_shell_actually_reads(tmp_path, monkeypatch):
    """``~/.profile`` is the POSIX answer and the wrong one on a default macOS box: a non-login
    zsh reads ``~/.zshrc`` and never sources it, so we would report success and fund nothing."""
    monkeypatch.setattr(llm_cmd.Path, "home", staticmethod(lambda: tmp_path))
    spec = {"fmt": "block", "path": ".profile", "lines": ["export A=1"]}

    monkeypatch.setenv("SHELL", "/bin/zsh")
    llm_cmd._write_user_config("copilot", spec)
    assert "export A=1" in (tmp_path / ".zshrc").read_text()

    monkeypatch.setenv("SHELL", "/bin/bash")
    llm_cmd._write_user_config("copilot", spec)
    assert "export A=1" in (tmp_path / ".bashrc").read_text()


# ------------------------------------------------------------------ `set auto`


def test_auto_reports_the_resolvers_winner_not_an_auto_eligible_row():
    """``auto`` promises the source a spawn would really get. ``STATUS``'s device login carries
    ``auto: True`` and is NOT what resolves, so reading that field would name the wrong row."""
    row = llm_cmd._auto_source(STATUS)

    assert row is not None
    assert (row.name, row.typeid) == ("team pool", EP)


def test_auto_prefers_the_default_vendors_source():
    """Any funded row is a truthful answer to "is this box funded", but a person at a prompt is
    usually about to run THEIR harness, and naming a source that funds a different one reads as
    a wrong answer."""
    status = {
        **STATUS,
        "resolved": {
            # Rank order would put the shared pool first; only claude's own row funds claude.
            # Both verified — this test is about WHICH funded row is named, not about whether
            # either is usable.
            "harness.codex.cli": {"endpoint_typeid": EP, "origin": "user", "unverified": False},
            "harness.claude.cli": {"endpoint_typeid": DEVICE, "origin": "user", "unverified": False},
        },
    }

    assert llm_cmd._auto_source(status).typeid == DEVICE


def test_auto_finds_nothing_when_nothing_resolves():
    """The whole trigger for opening the chooser. ``sources`` is still full here — offers are
    not funding, and answering from them would leave the box unable to issue a call."""
    assert llm_cmd._auto_source({**STATUS, "resolved": {}}) is None
    assert llm_cmd._auto_source({}) is None


def test_auto_is_matched_exactly_never_as_a_name_prefix():
    """``_pick`` resolves names by unique prefix, so a source called "Auto top-up" would answer
    to this word and the box would silently pick a row when it was asked a question."""
    assert llm_cmd._is_auto("auto") and llm_cmd._is_auto("  AUTO ")
    assert not llm_cmd._is_auto("auto top-up")
    assert not llm_cmd._is_auto("automatic")


def test_set_auto_reports_the_source_instead_of_looking_up_a_row(monkeypatch):
    """`flow llm set auto` reaches `_use_shell` as a row reference, because `set` is an alias of
    `use`. It must be answered as a question — a lookup would fail with NO_SUCH_ROW."""
    monkeypatch.setattr(llm_cmd, "_status", lambda *a, **k: STATUS)
    monkeypatch.setattr(llm_cmd, "_project_for_cwd", lambda **k: "")

    result = runner.invoke(app, ["llm", "set", "auto"])

    assert result.exit_code == 0, result.output
    assert "team pool" in result.output


def test_auto_never_opens_a_browser_when_the_box_is_already_funded(monkeypatch):
    """The common case, and the one that must cost nothing: a funded box answers from a pure
    read, with no window and no server."""
    monkeypatch.setattr(llm_cmd, "_status", lambda *a, **k: STATUS)
    monkeypatch.setattr(llm_cmd, "_project_for_cwd", lambda **k: "")

    def _no(*_a, **_k):
        raise AssertionError("a funded box must not be sent to the chooser")

    monkeypatch.setattr(llm_cmd, "_serve_chooser_here", _no)
    monkeypatch.setattr(llm_cmd, "_await_funding", _no)

    result = runner.invoke(app, ["llm", "auto", "--json"])

    assert result.exit_code == 0, result.output
    assert json.loads(result.output)["source"]["typeid"] == EP


def test_auto_with_no_browser_refuses_and_hands_back_the_chooser_url(monkeypatch):
    """An agent that cannot open a window can still hand the URL to the person who can, so the
    refusal carries it rather than only saying no."""
    monkeypatch.setattr(llm_cmd, "_status", lambda *a, **k: {**STATUS, "resolved": {}})
    monkeypatch.setattr(llm_cmd, "_project_for_cwd", lambda **k: "")
    monkeypatch.setattr(llm_cmd, "_backend_port", lambda: None)

    result = runner.invoke(app, ["llm", "auto", "--no-browser"])

    assert result.exit_code == llm_cmd.EXIT_NOT_FOUND, result.output
    assert llm_cmd._CHOOSER_PATH in result.output


def test_the_chooser_path_is_the_address_the_backend_registers():
    """The CLI hands a user this URL; a view type that does not exist would 404 them."""
    from flow_sdk.core.dock_address import VIEW_META, PointerRequirement, ViewType, dock_url

    assert llm_cmd._CHOOSER_PATH == dock_url(ViewType.LLM_SETUP)
    # Pointer NONE: the screen asks one question and has no selection to address.
    assert VIEW_META[ViewType.LLM_SETUP].pointer is PointerRequirement.NONE


def test_a_machine_with_no_browser_is_told_the_url_not_that_one_opened(monkeypatch):
    """`webbrowser.open` answers False without raising on a headless box (SSH, CI, no display).
    Ignoring that printed "Opened <url>" over a window that does not exist and then blocked on a
    socket nobody would satisfy — a lie followed by a hang, the one shape a CLI must not have."""
    import asyncio

    sent: list[str] = []

    class _Socket:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_a):
            return False

        def __aiter__(self):
            return self

        async def __anext__(self):
            raise StopAsyncIteration

    monkeypatch.setattr(llm_cmd, "_status", lambda *a, **k: {**STATUS, "resolved": {}})
    monkeypatch.setattr("webbrowser.open", lambda _url: False)
    monkeypatch.setattr("websockets.connect", lambda *a, **k: _Socket())
    monkeypatch.setattr(typer, "echo", lambda msg="", **k: sent.append(str(msg)))

    assert asyncio.run(llm_cmd._await_funding(6001, "http://127.0.0.1:6001/dock/llm-setup")) is None

    said = "\n".join(sent)
    assert "No browser on this machine" in said and "/dock/llm-setup" in said
    assert "Opened http" not in said


# ------------------------------------------- evidence, not a presumed device login


def test_a_presumed_device_login_is_not_evidence_the_box_can_issue_a_call():
    """The CLI reads the backend's ``unverified`` verdict; it does not re-derive it. WHY a
    device login is unverified is pinned in ``tests/unit/test_llm_source_resolution.py``,
    beside ``Candidate.unverified`` — one rule, one owner, one test."""
    status = {
        "sources": {"harness.codex.cli": [{"endpoint_typeid": DEVICE, "name": "codex device login", "rank": 0}]},
        "resolved": {"harness.codex.cli": {"endpoint_typeid": DEVICE, "origin": "default", "unverified": True}},
        "endpoints": {DEVICE: {"kind": "device", "provider": ""}},
    }

    assert llm_cmd._auto_source(status) is None


def test_a_verified_source_is_evidence():
    status = {
        "sources": {"harness.codex.cli": [{"endpoint_typeid": DEVICE, "name": "codex device login", "rank": 0}]},
        "resolved": {"harness.codex.cli": {"endpoint_typeid": DEVICE, "origin": "default", "unverified": False}},
        "endpoints": {DEVICE: {"kind": "device", "provider": ""}},
    }

    assert llm_cmd._auto_source(status).name == "codex device login"


def test_a_verdict_with_no_flag_is_not_evidence():
    """A missing ``unverified`` means the backend is older than this CLI — which is the NORMAL
    state right after an upgrade, because a server keeps the code it loaded at start until
    something restarts it. Reading that silence as "verified" told a box with codex not
    installed at all that `codex device login funds codex`; the user finds out when a call
    fails. Failing safe costs a chooser nobody strictly needed."""
    older = {
        **STATUS,
        "resolved": {
            kind: {k: v for k, v in (pick or {}).items() if k != "unverified"}
            for kind, pick in STATUS["resolved"].items()
        },
    }

    assert llm_cmd._auto_source(older) is None


def test_auto_probes_before_sending_anyone_to_a_browser(monkeypatch):
    """A device login is only ``cached`` once something probed it, and with NO backend nothing
    ever has — so requiring evidence alone would send a perfectly good box to the chooser every
    time. Ask first; a browser is far more expensive than a local subprocess."""
    unproven = {
        "sources": {
            "harness.claude.cli": [
                {"endpoint_typeid": DEVICE, "name": "claude device login", "rank": 0, "unverified": True},
            ]
        },
        "resolved": {"harness.claude.cli": {"endpoint_typeid": DEVICE, "origin": "default", "unverified": True}},
        "endpoints": {DEVICE: {"kind": "device", "provider": ""}},
    }
    probed = {
        **unproven,
        "resolved": {
            "harness.claude.cli": {"endpoint_typeid": DEVICE, "origin": "default", "unverified": False},
        },
    }
    calls: list[str] = []
    seq = [unproven, probed]

    monkeypatch.setattr(llm_cmd, "_project_for_cwd", lambda **k: "")
    monkeypatch.setattr(llm_cmd, "_status", lambda *a, **k: seq[min(len(calls), 1)])
    monkeypatch.setattr(llm_cmd, "_op", lambda op, payload=None: calls.append(op) or {})
    monkeypatch.setattr(llm_cmd, "_serve_chooser_here", lambda: pytest.fail("probed box must not open a browser"))

    row = llm_cmd._resolve_or_choose()

    assert calls == ["test_source"], "the un-probed device login was never asked"
    assert row.name == "claude device login"


# ---------------------------------------- reusing the app that is already open


def test_an_already_open_app_is_steered_rather_than_a_second_window_opened(monkeypatch):
    """A second window is the wrong answer when the app is already in front of the user: they
    end up with two Flowpads, and the one they were looking at is not the one being asked the
    question."""
    posted: list[tuple[str, dict]] = []

    class _Resp:
        status_code = 200

        @staticmethod
        def json():
            return {"ok": True}

    monkeypatch.setattr(llm_cmd, "_local_post", lambda url, **kw: posted.append((url, kw.get("json") or {})) or _Resp())
    monkeypatch.setattr("webbrowser.open", lambda _u: pytest.fail("a second window was opened"))

    assert llm_cmd._steer_open_app(6060) is True
    url, body = posted[0]
    assert url.endswith("/api/v1/agent/navigate/view")
    assert body == {"view": "llm-setup"}, "must name the chooser's dock address"


def test_no_listening_tab_falls_back_to_a_browser(monkeypatch):
    """`NO_ACTIVE_TAB`, an older server with no such route, a refusal — all mean the same thing
    to this caller: nobody is home, so open a window."""

    class _Refused:
        status_code = 200

        @staticmethod
        def json():
            return {"ok": False, "error_code": "NO_ACTIVE_TAB"}

    monkeypatch.setattr(llm_cmd, "_local_post", lambda url, **kw: _Refused())
    assert llm_cmd._steer_open_app(6060) is False

    def _boom(*_a, **_k):
        raise ConnectionError("no such route")

    monkeypatch.setattr(llm_cmd, "_local_post", _boom)
    assert llm_cmd._steer_open_app(6060) is False, "a transport failure is not fatal here"


# ─────────────────────────────────────────────────────────────────────────────
# `auto` — the answer, in every case
#
# One command, one promise: name the source a spawn would REALLY get, or say there is none.
# Both halves of that are load-bearing and fail in opposite, expensive directions — a false
# "you are set up" is found out when a call fails, a false "you have nothing" sends a funded
# box to a browser it did not need. So the truth table is pinned here case by case rather than
# sampled.
# ─────────────────────────────────────────────────────────────────────────────

KEY = "llm_endpoint:key-openrouter"


def _one(kind: str, *, unverified: bool | None, typeid: str = DEVICE, harness: str = "claude") -> dict:
    """A status carrying exactly one resolved source of *kind*.

    ``unverified=None`` omits the flag entirely — the shape an older backend sends.
    """
    pick: dict = {"endpoint_typeid": typeid, "origin": "default"}
    if unverified is not None:
        pick["unverified"] = unverified
    return {
        "sources": {f"harness.{harness}.cli": [{"endpoint_typeid": typeid, "name": "the source", "rank": 0}]},
        "resolved": {f"harness.{harness}.cli": pick},
        "endpoints": {typeid: {"kind": kind, "provider": "openrouter" if kind == "api_key" else ""}},
    }


@pytest.mark.parametrize(
    "kind,unverified,expected",
    [
        # Verified: every kind of source is a real answer. A hub endpoint is the FlowPad tile's
        # own outcome, so it failing here would break the headline path.
        ("hub", False, "the source"),
        ("device", False, "the source"),
        ("api_key", False, "the source"),
        # Unverified: the backend says it cannot vouch for this, whatever kind it is.
        ("hub", True, None),
        ("device", True, None),
        ("api_key", True, None),
        # No flag at all — an older backend. Fails SAFE: silence is not a yes. Getting this
        # wrong told a box with codex not installed that `codex device login funds codex`.
        ("hub", None, None),
        ("device", None, None),
        ("api_key", None, None),
    ],
)
def test_auto_answers_each_kind_and_verdict(kind, unverified, expected):
    row = llm_cmd._auto_source(_one(kind, unverified=unverified))

    assert (row.name if row else None) == expected


def test_auto_picks_the_verified_source_over_an_unverified_one():
    """The common shape on a real box: several offers, only some of them provable."""
    status = {
        "sources": {
            "harness.claude.cli": [{"endpoint_typeid": DEVICE, "name": "claude device login", "rank": 0}],
            "harness.codex.cli": [{"endpoint_typeid": EP, "name": "team pool", "rank": 5}],
        },
        "resolved": {
            "harness.claude.cli": {"endpoint_typeid": DEVICE, "origin": "default", "unverified": True},
            "harness.codex.cli": {"endpoint_typeid": EP, "origin": "user", "unverified": False},
        },
        "endpoints": {DEVICE: {"kind": "device", "provider": ""}, EP: {"kind": "hub", "provider": "openrouter"}},
    }

    row = llm_cmd._auto_source(status)

    assert row is not None and row.typeid == EP, "an unverified row outranked a provable one"


def test_auto_ignores_a_verdict_naming_a_source_the_listing_never_sent():
    """A resolved pick carries only a typeid. If the row it names is absent, there is nothing to
    report — inventing one would put a name in front of the user that no listing backs."""
    status = {
        "sources": {},
        "resolved": {"harness.claude.cli": {"endpoint_typeid": "llm_endpoint:ghost", "unverified": False}},
        "endpoints": {},
    }

    assert llm_cmd._auto_source(status) is None


def test_auto_falls_back_when_the_default_vendor_is_not_the_funded_one():
    """The default vendor is a PREFERENCE among funded rows, never a filter. Treating it as a
    filter would report "nothing" on a box that is demonstrably funded — for another harness."""
    status = {
        "sources": {"harness.opencode.cli": [{"endpoint_typeid": KEY, "name": "openrouter key", "rank": 0}]},
        "resolved": {"harness.opencode.cli": {"endpoint_typeid": KEY, "origin": "user", "unverified": False}},
        "endpoints": {KEY: {"kind": "api_key", "provider": "openrouter"}},
    }

    row = llm_cmd._auto_source(status)

    assert row is not None and row.active_for == ["opencode"]


def test_auto_answers_nothing_on_an_empty_box():
    assert llm_cmd._auto_source({}) is None
    assert llm_cmd._auto_source({"sources": {}, "resolved": {}, "endpoints": {}}) is None


# ── what the user actually sees ──────────────────────────────────────────────


def test_the_human_line_names_the_source_its_kind_and_what_it_funds(capsys):
    llm_cmd._report(llm_cmd._rows(STATUS)[0], json_output=False)

    line = capsys.readouterr().out
    # `endpoint`, not `hub`: `_select_kind` renders the hub kind in the spelling `select`
    # speaks, and this line is what a person reads.
    assert "team pool" in line and "endpoint" in line and "claude,codex" in line


def test_the_json_form_is_the_whole_row_under_a_stable_key(capsys):
    """Agents parse this. The envelope (`ok`) and the key (`source`) are the contract."""
    llm_cmd._report(llm_cmd._rows(STATUS)[0], json_output=True)

    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is True
    assert payload["source"]["typeid"] == EP
    assert payload["source"]["active_for"] == ["claude", "codex"]


# ── the wait, and how it ends ────────────────────────────────────────────────


class _Frames:
    """`_backend_frames` stand-in: yields the given frames, then closes like a real socket."""

    def __init__(self, frames):
        self._frames = frames

    def __call__(self, port, kinds, *, on_connected=None):
        async def gen():
            if on_connected is not None:
                await on_connected()
            for frame in self._frames:
                yield frame

        return gen()


def test_the_wait_returns_the_source_as_soon_as_one_appears(monkeypatch):
    """The frame is a WAKE-UP, never the answer: it says a credential changed, and only the
    resolver can say whether the box can now fund a call."""
    import asyncio

    # First wake: a credential changed but nothing is funded yet. Second: funded. Proves the
    # command keeps waiting through a frame that did not answer the question.
    seq = iter([{"sources": {}, "resolved": {}, "endpoints": {}}, STATUS])
    monkeypatch.setattr(llm_cmd, "_backend_frames", _Frames([{"message_type": "llm_config_msg"}] * 2))
    monkeypatch.setattr(llm_cmd, "_steer_open_app", lambda port: True)
    monkeypatch.setattr(llm_cmd, "_status", lambda *a, **k: next(seq))

    row = asyncio.run(llm_cmd._await_funding(6060, "http://127.0.0.1:6060/dock/llm-setup"))

    assert row is not None and row.typeid == EP


def test_the_wait_ends_empty_when_the_socket_closes_with_nothing_chosen(monkeypatch):
    """`None` means the server went away — the caller turns that into a connection error, not
    into "you have no sources", which would be a different and wrong message."""
    import asyncio

    monkeypatch.setattr(llm_cmd, "_backend_frames", _Frames([]))
    monkeypatch.setattr(llm_cmd, "_steer_open_app", lambda port: True)
    monkeypatch.setattr(llm_cmd, "_status", lambda *a, **k: {"resolved": {}})

    assert asyncio.run(llm_cmd._await_funding(6060, "u")) is None


def test_a_lost_socket_is_a_connection_error_not_a_missing_source(monkeypatch):
    """Exit code contract: 5 (CONNECTION_ERROR), not 4 (nothing to act on). An agent retries
    one and gives up on the other."""
    monkeypatch.setattr(llm_cmd, "_status", lambda *a, **k: {"resolved": {}})
    monkeypatch.setattr(llm_cmd, "_project_for_cwd", lambda **k: "")
    monkeypatch.setattr(llm_cmd, "_probe_unproven_device_logins", lambda status: status)
    monkeypatch.setattr(llm_cmd, "_backend_port", lambda: 6060)
    monkeypatch.setattr(llm_cmd, "_await_funding", lambda port, url: None)
    monkeypatch.setattr("asyncio.run", lambda coro: None)

    result = runner.invoke(app, ["llm", "auto"])

    assert result.exit_code == llm_cmd.EXIT_CONNECTION_ERROR
    assert "CONNECTION_ERROR" in result.output
