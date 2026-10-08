"""The diagnose runner: the project's diagnose first, the shipped one else, and ALWAYS a diagnosis --
a diagnose that is missing, broken, raising, hanging (async or blocking) or answering nonsense
still yields the baseline, marked partial, with the reason."""

from __future__ import annotations

import json
import textwrap
import time

import pytest

from flow_sdk.diagnose import DiagnosisSpec, DiagnosisStatus, FlowContextSpec, run_diagnose
from flow_sdk.diagnose.baseline import redact
from flow_sdk.diagnose.runner import GENERIC, DiagnoseError, resolve_diagnose

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval

GOOD = """
from flow_sdk.diagnose import DiagnosisSpec, progress

def diagnose(ctx):
    progress("looking")
    return DiagnosisSpec(status="needs_action", title="own", summary=ctx.user_report)
"""


def _project(tmp_path, body: str, *, name: str = "mine", timeout_s: float = 5) -> str:
    folder = tmp_path / "agentic-assets" / "diagnose" / name
    folder.mkdir(parents=True)
    (folder / "diagnose.json").write_text(json.dumps({"name": name, "timeout_s": timeout_s}))
    (folder / "diagnose.py").write_text(textwrap.dedent(body))
    return str(tmp_path)


def _ctx(project_path: str | None = None) -> FlowContextSpec:
    return FlowContextSpec(project_path=project_path, user_report="it broke", origin="test")


def test_a_project_without_its_own_is_diagnosed_by_the_shipped_one(tmp_path):
    folder, spec = resolve_diagnose(str(tmp_path))
    assert spec.name == GENERIC and folder.name == GENERIC


def test_the_projects_own_diagnose_wins(tmp_path):
    folder, spec = resolve_diagnose(_project(tmp_path, GOOD))
    assert spec.name == "mine" and folder.parent == tmp_path / "agentic-assets" / "diagnose"


def test_the_shipped_diagnose_ignores_a_projects_own(tmp_path):
    """Flowpad diagnoses itself with its own checks; a project overrides only what a helper is sent."""
    from flow_sdk.diagnose import resolve_shipped

    project = _project(tmp_path, GOOD)
    assert resolve_diagnose(project)[1].name == "mine", "asking for help takes the project's own"
    assert resolve_shipped()[1].name == GENERIC, "the Diagnose button never does"


def test_an_invalid_diagnose_json_is_refused_by_name(tmp_path):
    folder = tmp_path / "agentic-assets" / "diagnose" / "bad"
    folder.mkdir(parents=True)
    (folder / "diagnose.json").write_text('{"name": "bad", "nonsense": 1}')
    with pytest.raises(DiagnoseError, match="bad/diagnose.json is invalid"):
        resolve_diagnose(str(tmp_path))


async def test_a_good_diagnose_answers_with_the_baseline_filled_in(tmp_path):
    heard: list[str] = []
    d = await run_diagnose(_ctx(_project(tmp_path, GOOD)), emit=heard.append)
    assert (d.status, d.title, d.summary, d.diagnose) == (DiagnosisStatus.NEEDS_ACTION, "own", "it broke", "mine")
    assert d.errors == [] and d.environment.os and d.context.user_report == "it broke"
    assert d.symptoms == "it broke" and d.started_at and d.elapsed_ms >= 0
    assert heard == ["looking"]


async def test_an_async_diagnose_and_a_dict_answer_are_accepted(tmp_path):
    body = """
    async def diagnose(ctx):
        return {"spec_kind": "diagnosis", "status": "ok", "title": "fine"}
    """
    d = await run_diagnose(_ctx(_project(tmp_path, body)))
    assert (d.status, d.title, d.errors) == (DiagnosisStatus.OK, "fine", [])


@pytest.mark.parametrize(
    ("body", "reason"),
    [
        ("def diagnose(ctx):\n    raise RuntimeError('boom')\n", "mine failed: RuntimeError: boom"),
        ("import not_a_module_anywhere\n", "failed to import"),
        ("x = 1\n", "defines no diagnose(ctx)"),
        ("def diagnose(ctx):\n    return 42\n", "not a diagnosis"),
        ("def diagnose(ctx):\n    return {'status': 'sideways'}\n", "not a diagnosis: status: Input should be"),
    ],
    ids=["raises", "import-error", "no-entry", "not-a-value", "invalid-value"],
)
async def test_a_failing_diagnose_still_answers_the_baseline(tmp_path, body, reason):
    d = await run_diagnose(_ctx(_project(tmp_path, body)))
    assert d.status == DiagnosisStatus.PARTIAL
    assert any(reason in e for e in d.errors), d.errors
    assert d.environment.os and d.symptoms == "it broke" and d.context is not None


@pytest.mark.parametrize(
    "body",
    [
        "import asyncio\nasync def diagnose(ctx):\n    await asyncio.sleep(3600)\n",
        # Blocks its thread outright: the backend's loop must not be the one that waits.
        "import threading\ndef diagnose(ctx):\n    threading.Event().wait()\n",
    ],
    ids=["async-hang", "blocking-hang"],
)
async def test_a_hanging_diagnose_is_cut_off_at_its_own_budget(tmp_path, body):
    started = time.monotonic()
    d = await run_diagnose(_ctx(_project(tmp_path, body, timeout_s=0.3)))
    assert time.monotonic() - started < 2
    assert d.status == DiagnosisStatus.PARTIAL
    assert d.errors == ["mine did not finish within 0.3s"]


async def test_no_diagnose_at_all_still_answers(tmp_path):
    def nothing(_path):
        raise DiagnoseError("the shipped 'flowpad' diagnose is missing")

    d = await run_diagnose(_ctx(str(tmp_path)), resolve=nothing)
    assert d.status == DiagnosisStatus.PARTIAL and d.diagnose == ""
    assert d.errors == ["the shipped 'flowpad' diagnose is missing"]


async def test_the_shipped_diagnose_runs_and_validates(tmp_path, monkeypatch):
    """A unit test never reaches a real backend or hub: both probes answer "down" here."""

    async def no_hub():
        return None

    monkeypatch.setattr("flow_sdk.server.launch.check_server_health", lambda *_a, **_k: False)
    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.get_info", no_hub)
    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_base_url", lambda: "http://hub.invalid")
    heard: list[str] = []
    d = await run_diagnose(_ctx(str(tmp_path)), emit=heard.append)
    assert d.diagnose == GENERIC and d.errors == [], d.errors
    assert "C6" in {f.id for f in d.findings}, "the hub that did not answer is a finding"
    assert "checking the hub and sign-in" in heard, "progress from the checks' threads reaches the run"
    assert DiagnosisSpec.model_validate_json(d.model_dump_json()) == d


def test_the_diagnosis_round_trips_with_its_kind_on_the_wire():
    from flow_sdk.fs_store.schema_registry import SchemaRegistry
    from flow_sdk.schema.data_spec._kinds import register_builtin_kinds

    register_builtin_kinds()
    assert SchemaRegistry.kind_type("diagnosis") is DiagnosisSpec
    assert SchemaRegistry.kind_type("flow.context") is FlowContextSpec


@pytest.mark.parametrize(
    "line",
    [
        "Authorization: Bearer abcdefghijklmnop1234",
        'token="abcd1234efgh"',
        "api_key=sk-ant-abcdefghijklmnopqrstu",
        "cookie: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
    ],
)
def test_log_tails_carry_no_secret(line):
    assert "[redacted]" in redact(line)
    for secret in ("abcdefghijklmnop1234", "abcd1234efgh", "sk-ant-", "dozjgNryP4J3"):
        assert secret not in redact(line)


def test_a_signed_out_machine_still_says_who_ran_it(monkeypatch):
    """A supporter's request runs on a box with no account: the run names the computer's login rather
    than arriving as "From: unknown"."""
    import getpass
    import platform

    from flow_sdk.diagnose import baseline
    from flow_sdk.server.routes import bootstrap

    monkeypatch.setattr(bootstrap, "get_name", lambda: "")
    monkeypatch.setattr(bootstrap, "get_email", lambda: "")

    assert baseline.environment().reported_by == f"{getpass.getuser()} on {platform.node()}"
