"""A source that reads through a sign-in says so — as data — and its setup never reads "done" while it waits.

* Verify probes the connection the source acts through (its driver's ``auth.connector``), not ``channel`` — the
  origin kind, which names where messages go. A source with no token is in SETUP, and ``setup_needs`` names the
  sign-in, so a surface can say "Needs GitHub sign-in" without parsing a sentence.
* A connection's own needs are steps of their own (``requirement_step``): its provider exists, the project holds
  its credential.
* A setup that fell short stays the record: the load pass after it (same run key) used to overwrite it with
  "done", and the setup step closed itself over a source still in setup.
"""

from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin import project_setup
from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.data_source import DataSource, SourceStatus
from flow_sdk.core.oauth import provider_probe
from flow_sdk.schema.data_spec.data_driver_spec import AuthSpec, DataDriverSpec
from flow_sdk.sources.families import RecordSource
from flow_sdk.sources.protocols import Verdict

pytestmark = [
    pytest.mark.asyncio,
    pytest.mark.timeout(30),  # do not increase timeout without approval
    pytest.mark.usefixtures("fresh_user_scope"),
]

PROVIDER = "signin-test"


class _SignedIn(RecordSource):
    provider = PROVIDER

    async def verify(self) -> Verdict:
        return Verdict(ready=True, detail="reading")


@pytest.fixture
def driver():
    manifest = DataDriverSpec.model_validate({"schema": 1, "name": PROVIDER, "auth": AuthSpec(connector="github")})
    DataDriver.register(DataDriver.for_class(_SignedIn, manifest, kind="datasource.test.signin"))


@pytest.fixture
def probe(monkeypatch):
    """The sign-in check's answer (the token the poll would use, probed), per provider asked."""
    asked: list[str] = []
    answer: dict = {"ok": False, "code": "missing_token", "detail": "No token stored for this provider"}

    async def connection_answer(provider: str):
        asked.append(provider)
        return dict(answer)

    monkeypatch.setattr(provider_probe, "connection_answer", connection_answer)
    return asked, answer


async def _source(**kw) -> DataSource:
    src = DataSource(name=f"signin {uuid.uuid4().hex[:8]}", account_key=f"a-{uuid.uuid4().hex[:6]}",
                     provider=PROVIDER, **kw)
    await src.save()
    return src


async def test_no_token_keeps_the_source_in_setup_and_names_the_sign_in(driver, probe):
    asked, _ = probe
    src = await _source()

    result = await src.verify()

    assert asked == ["github"], "the connector is probed — never `channel`, the origin kind"
    assert result["ready"] is False and result["layer"] == "connection"
    assert src.status == SourceStatus.SETUP.value
    (need,) = src.setup_needs
    assert (need.kind, need.name, need.title, need.state) == ("connection", "github", "GitHub", "missing")
    assert src.setup_detail == "Needs GitHub sign-in"
    assert result["needs"][0]["title"] == "GitHub"


async def test_a_working_sign_in_goes_on_to_the_drivers_check_and_clears_the_needs(driver, probe):
    _, answer = probe
    src = await _source()
    await src.verify()
    answer.update(ok=True, code="", detail="")

    result = await src.verify()

    assert result["ready"] is True
    assert src.status == SourceStatus.ACTIVE.value
    assert src.setup_needs == []


async def test_the_account_a_source_is_bound_to_is_the_one_probed(driver, probe):
    asked, _ = probe
    src = await _source(connection="github")

    await src.verify()

    assert asked == ["github"]


async def test_a_provider_shipped_here_is_available_one_nobody_has_is_not(monkeypatch):
    from flow_sdk.core.connections import specs

    async def nowhere(provider):
        return None

    monkeypatch.setattr(specs, "resolve_connection_spec", nowhere)

    assert (await project_setup.requirement_step("", "provider:github", check=True))[0] is True
    held, detail = await project_setup.requirement_step("", "provider:no-such-provider", check=True)
    assert held is False and "no-such-provider" in detail


async def test_a_credential_step_for_no_project_is_a_verdict_not_an_error():
    held, detail = await project_setup.requirement_step("", "credential:github:not-an-id:repo,read:org", check=False)
    assert held is False and "no project" in detail


async def test_a_setup_that_fell_short_stays_the_record_after_the_load_pass(tmp_path, monkeypatch):
    """The load pass after a setup records under the same run key; a source has nothing to load, so it settled
    "done" over the failed setup — and the setup step closed itself, "completed", over a source in setup."""
    import asyncio
    from types import SimpleNamespace

    from flow_sdk.core import setup as core_setup
    from flow_sdk.core.wizard.state import record_tree, run_key
    from flow_sdk.schema.data_spec.asset_setup_spec import SetupState, SetupTreeResult

    root = f"data_source-{uuid.uuid4()}"
    passes = iter([SetupState.FAILED, SetupState.DONE])  # the setup falls short; the load has nothing to do

    async def execute_setup(root_id, *, record=True, **_kw):
        result = SetupTreeResult(state=next(passes), detail="")
        if record:  # what the real one does with `record`
            record_tree(run_key(core_setup.execute.SETUP_RUN, root_id), result)
        return result

    monkeypatch.setattr(core_setup, "execute_setup", execute_setup)
    tree = SimpleNamespace(root=root, resolve_node=None, resolve_op=None)
    project = SimpleNamespace(id=str(uuid.uuid4()), name="p", fs_storage_mount_path=str(tmp_path))

    await project_setup.start_setup(project, root=root, tree=tree)
    await asyncio.wait_for(project_setup._RUNS[(project.id, root)], 10)

    assert core_setup.read_setup(root).state is SetupState.FAILED
