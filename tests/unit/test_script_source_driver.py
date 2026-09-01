"""A data source whose driver is a script, driven against real processes.

A mock cannot tell you whether the request reached the child, whether a non-zero
exit was classified, or whether the header the module tried to forge was
ignored — those are properties of spawning, so every test here spawns.

The rules being pinned are the ones that bite silently:

* an omitted `state` must CARRY FORWARD, because `sync.py` assigns
  `cursor.state = result.next_state or {}` unconditionally and would otherwise
  reset a module's own resumption point every tick;
* the item header is stamped by the host, so an authored source cannot mint
  records attributed to somebody else;
* a spec may not shadow a shipped driver;
* `verify` is present only when the spec declares a setup step, because
  `DataSource.save()` reads the METHOD's presence to resolve NEW.
"""
from __future__ import annotations

import json
import stat
from pathlib import Path

import pytest

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.ingest.driver import SegmentCursorView
from flow_sdk.ingest.drivers.script import ScriptSource, driver_for_spec
from flow_sdk.ingest.health import SourceError

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


class _Spec:
    """The fields `driver_for_spec` reads off a spec row / FSRecord.

    `asset_ref` is an **FSRef**, not a string: that is what the entity carries on
    the in-process path, and a string stub is why a real instance once looked for
    `fetch.py` inside a folder literally named `FSRef('/…')`.
    """

    def __init__(self, folder: Path, **over):
        self.name = over.get("name", "acme")
        self.runtime = over.get("runtime", "script")
        self.asset_ref = FSRef(folder)
        self.traits = over.get("traits", {"emits": "content.doc"})
        self.auth = over.get("auth", {})
        self.setup_wiki = over.get("setup_wiki", "")
        self.id = "spec-1"


class _Source:
    def __init__(self, **config):
        self.id = "src-1"
        self.name = "Acme"
        self.account_key = "acme"
        self.config = config
        self.window_days = 7


def _module(folder: Path, body: str) -> None:
    """A real fetch.py. `body` sees `req` (the parsed request) and `verb`."""
    folder.mkdir(parents=True, exist_ok=True)
    src = (
        "import json,sys\n"
        "verb = sys.argv[1]\n"
        "req = json.load(open(sys.argv[3]))\n"
        f"{body}\n"
    )
    path = folder / "fetch.py"
    path.write_text(src, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


def _view(state=None, segment="root") -> SegmentCursorView:
    return SegmentCursorView(segment_key=segment, state=state or {}, first_run=not state)


async def test_segments_round_trip(tmp_path):
    _module(tmp_path, "print(json.dumps({'segments':[{'key':'a','label':'A'},{'key':'b'}]}))")
    driver = driver_for_spec(_Spec(tmp_path))

    refs = await driver.segments(_Source())

    assert [(r.key, r.label) for r in refs] == [("a", "A"), ("b", "")]


async def test_the_module_receives_the_source_config(tmp_path):
    _module(tmp_path, "print(json.dumps({'segments':[{'key':req['source']['config']['feed']}]}))")
    driver = driver_for_spec(_Spec(tmp_path))

    refs = await driver.segments(_Source(feed="https://example.com/f.xml"))

    assert refs[0].key == "https://example.com/f.xml"


async def test_items_get_their_header_stamped_by_the_host(tmp_path):
    # The module TRIES to forge the header. Every forged field must be ignored:
    # otherwise an authored source could write records attributed to another.
    _module(
        tmp_path,
        "print(json.dumps({'items':[{'external_id':'1','title':'t',"
        "'source_id':'somebody-else','provider':'rss','kind':'content.message.email',"
        "'segment_key':'not-mine'}]}))",
    )
    driver = driver_for_spec(_Spec(tmp_path))

    result = await driver.fetch(_Source(), _view(segment="mine"))

    item = result.items[0]
    assert (item.data_source_id, item.provider, item.kind, item.segment_key) == (
        "src-1", "acme", "content.doc", "mine",
    )


async def test_state_is_opaque_and_round_trips(tmp_path):
    _module(tmp_path, "print(json.dumps({'state':{'cursor_token':'T2','page':7}}))")
    driver = driver_for_spec(_Spec(tmp_path))

    result = await driver.fetch(_Source(), _view({"cursor_token": "T1"}))

    assert result.next_state == {"cursor_token": "T2", "page": 7}


async def test_an_omitted_state_carries_the_previous_one_forward(tmp_path):
    # `sync.py` does `cursor.state = result.next_state or {}` unconditionally, so
    # a module returning only items would otherwise wipe its own position.
    _module(tmp_path, "print(json.dumps({'items':[]}))")
    driver = driver_for_spec(_Spec(tmp_path))

    result = await driver.fetch(_Source(), _view({"cursor_token": "T1"}))

    assert result.next_state == {"cursor_token": "T1"}


async def test_an_explicit_empty_state_clears_it(tmp_path):
    _module(tmp_path, "print(json.dumps({'state':{}}))")
    driver = driver_for_spec(_Spec(tmp_path))

    result = await driver.fetch(_Source(), _view({"cursor_token": "T1"}))

    assert result.next_state == {}


async def test_an_item_without_an_external_id_is_a_config_error(tmp_path):
    # The natural key is (source_id, segment_key, external_id) — a blank one
    # collapses every item in the segment onto one row.
    _module(tmp_path, "print(json.dumps({'items':[{'title':'no id'}]}))")
    driver = driver_for_spec(_Spec(tmp_path))

    with pytest.raises(SourceError) as caught:
        await driver.fetch(_Source(), _view())

    assert caught.value.health.value == "config_error"


async def test_exit_3_parks_and_exit_4_retries(tmp_path):
    _module(tmp_path, "sys.exit(3)")
    driver = driver_for_spec(_Spec(tmp_path))
    with pytest.raises(SourceError) as parked:
        await driver.fetch(_Source(), _view())
    assert parked.value.health.value == "config_error"

    _module(tmp_path, "sys.exit(4)")
    with pytest.raises(SourceError) as retried:
        await driver.fetch(_Source(), _view())
    assert retried.value.health.value == "transient_error"


async def test_a_missing_module_parks_instead_of_retrying_forever(tmp_path):
    # A spawn failure surfaces as exit 127, which `module_rpc` classifies
    # transient — correctly, since it did not define that code. Left alone it
    # would retry a deleted file every minute forever.
    driver = driver_for_spec(_Spec(tmp_path))  # no fetch.py written

    with pytest.raises(SourceError) as caught:
        await driver.fetch(_Source(), _view())

    assert caught.value.health.value == "config_error"
    assert caught.value.code == "missing_module"


async def test_stdout_that_is_not_the_contract_is_a_config_error(tmp_path):
    _module(tmp_path, "print('not json at all')")
    driver = driver_for_spec(_Spec(tmp_path))

    with pytest.raises(SourceError) as caught:
        await driver.fetch(_Source(), _view())

    assert caught.value.health.value == "config_error"


async def test_verify_exists_only_when_the_spec_declares_a_setup_step(tmp_path):
    _module(tmp_path, "print(json.dumps({'ready':False,'detail':'Invite the bot.','pending':['#eng']}))")

    plain = driver_for_spec(_Spec(tmp_path))
    assert isinstance(plain, ScriptSource)
    # `DataSource.save()` resolves NEW by asking whether this is callable.
    assert not callable(getattr(plain, "verify", None))

    with_setup = driver_for_spec(_Spec(tmp_path, setup_wiki="Acme setup"))
    assert with_setup.verify is not None
    verdict = await with_setup.verify(_Source())
    assert (verdict.ready, verdict.detail, verdict.pending) == (False, "Invite the bot.", ("#eng",))


async def test_traits_become_the_declared_attributes(tmp_path):
    driver = driver_for_spec(
        _Spec(tmp_path, traits={"emits": "content.message.chat", "channel": "acme", "owns_bytes": False})
    )

    assert driver.record_kind == "content.message.chat"
    assert driver.channel_for(_Source()) == "acme"
    # A source mirroring somebody else's tree must not stamp identity into it.
    assert driver.stamps_identity is False


async def test_a_plain_string_asset_ref_also_resolves(tmp_path):
    # The entity declares `asset_ref` as `Optional[str]`, so a row hydrated over
    # HTTP carries a string while the in-process one carries an FSRef. Both have
    # to find the module.
    _module(tmp_path, "print(json.dumps({'segments':[{'key':'a'}]}))")
    spec = _Spec(tmp_path)
    spec.asset_ref = str(tmp_path)

    refs = await driver_for_spec(spec).segments(_Source())

    assert [r.key for r in refs] == ["a"]


async def test_a_builtin_runtime_spec_gets_no_adapter(tmp_path):
    # The manifest describes a driver that already exists as a class; registering
    # anything would shadow the real one.
    assert driver_for_spec(_Spec(tmp_path, runtime="builtin")) is None


async def test_a_declared_env_var_that_is_missing_parks_the_source(tmp_path, monkeypatch):
    monkeypatch.delenv("ACME_KEY", raising=False)
    _module(tmp_path, "print(json.dumps({'segments':[]}))")
    driver = driver_for_spec(_Spec(tmp_path, auth={"env": ["ACME_KEY"]}))

    with pytest.raises(SourceError) as caught:
        await driver.segments(_Source())

    assert caught.value.code == "missing_env"


async def test_a_declared_env_var_reaches_the_module(tmp_path, monkeypatch):
    monkeypatch.setenv("ACME_KEY", "sekrit")
    _module(tmp_path, "import os; print(json.dumps({'segments':[{'key':os.environ['ACME_KEY']}]}))")
    driver = driver_for_spec(_Spec(tmp_path, auth={"env": ["ACME_KEY"]}))

    refs = await driver.segments(_Source())

    assert refs[0].key == "sekrit"


async def test_the_module_never_writes_into_the_spec_folder(tmp_path):
    # `call_module` drops request.json into the workdir; if that were the asset
    # folder it would dirty a git-tracked tree.
    _module(tmp_path, "print(json.dumps({'segments':[]}))")
    driver = driver_for_spec(_Spec(tmp_path))

    await driver.segments(_Source())

    assert not (tmp_path / "request.json").exists()
