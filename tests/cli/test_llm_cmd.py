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
    "resolved": {
        "harness.claude.cli": {"endpoint_typeid": EP, "origin": "user"},
        "harness.codex.cli": {"endpoint_typeid": EP, "origin": "user"},
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
