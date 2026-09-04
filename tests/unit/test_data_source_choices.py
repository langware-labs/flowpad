"""``DataSource.choices_for`` — the picker's data, and what it does when there is none.

The whole feature exists because three providers ask for values a person cannot produce
from memory. So the interesting cases here are not the happy list: they are the four ways
listing can fail, and the rule that separates them.

**A caller bug is loud; a user's situation is not.** An unknown provider, or a field the
manifest never marked `choices`, means the form asked about something it had no business
asking about — that answers `None`, and the action turns it into a failure. Everything a
person can actually cause — no connection, a missing scope, no project id — answers with
an empty `ChoiceSet` and one sentence, because for all of them the next step is the same:
type it instead.
"""
from __future__ import annotations

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.data_source_spec import DataSourceSpec
from flow_sdk.ingest.health import SourceError
from flow_sdk.schema.data_spec.choice_spec import Choice

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


@pytest.fixture
def provider(request):
    """A provider of our own: a stub driver in the registry and a manifest row to match.

    Not a real one. Every case here is about the plumbing between a manifest flag and a
    driver hook, and borrowing `rss` would both lie about which providers offer a picker
    and collide with the next test in this suite's shared database.
    """
    from flow_sdk.ingest.driver import DRIVERS, IngestDriver

    async def _make(hook=None, **config) -> str:
        name = f"stub-{mint_uuid()[:8]}"

        class _Stub(IngestDriver):
            provider = name
            kind = "datasource.test.stub"

        if hook is not None:
            _Stub.choices = hook
        DRIVERS.register(_Stub())
        request.addfinalizer(lambda: DRIVERS.unregister(name))
        await DataSourceSpec(name=name, title=name, config=config).save()
        return name

    return _make


def _field(**over) -> dict:
    """A config field the manifest marks choosable."""
    return {"type": "lines", "choices": True, **over}


async def test_an_unmarked_field_is_a_caller_bug_not_an_empty_list(provider):
    """The form only asks about fields the manifest marked, so a miss is a bug.

    Answering `[]` would bury it as "nothing to pick" and the picker would look merely
    empty forever, on every machine, with nothing raising anywhere.
    """
    name = await provider(feed_urls={"type": "lines"})
    assert await DataSource.choices_for(name, "feed_urls") is None


async def test_an_unknown_provider_is_a_caller_bug():
    assert await DataSource.choices_for("nosuchprovider", "whatever") is None


async def test_a_marked_field_whose_driver_offers_nothing_still_is_not_a_dead_end(provider, caplog):
    """The shipped-manifest test catches this pairing at CI — but not for a spec
    authored outside this repo, and a person mid-form must still be able to proceed."""
    name = await provider(feed_urls=_field())
    picks = await DataSource.choices_for(name, "feed_urls")
    assert picks.items == []
    assert "type the value directly" in picks.detail
    assert any("offers none" in r.getMessage() for r in caplog.records), (
        "the mismatch is logged, not silent — it is a build-time bug reaching a user"
    )


async def test_a_refusal_carries_the_provider_s_own_sentence(provider):
    """`SourceError` is caught HERE, once, so three drivers cannot word it three ways."""
    async def _refuse(self, source, field):
        raise SourceError.config("no_project", "Set 'GCP project' to list buckets.")

    name = await provider(_refuse, feed_urls=_field())
    picks = await DataSource.choices_for(name, "feed_urls")
    assert picks.items == []
    assert picks.detail == "Set 'GCP project' to list buckets.", (
        "the sentence is rendered verbatim under the field, so it carries no machine code"
    )


async def test_a_driver_that_blows_up_does_not_500_the_picker(provider):
    async def _boom(self, source, field):
        raise RuntimeError("kaboom")

    name = await provider(_boom, feed_urls=_field())
    picks = await DataSource.choices_for(name, "feed_urls")
    assert picks.items == [] and "kaboom" in picks.detail


async def test_the_driver_is_handed_an_unsaved_source_carrying_the_draft_config(provider):
    """The picker runs while CREATING a source, so there is no row — and must not mint one.

    The draft is shaped by the manifest's own catalog first, so a `lines` field arrives at
    the driver as a list even though the form holds it as one newline-joined string.
    """
    seen: dict = {}

    async def _capture(self, source, field):
        seen["config"] = dict(source.config or {})
        seen["saved"] = await DataSource.get_one({"id": source.id}) is not None
        return [Choice(id="a", name="Alpha", detail="one")]

    name = await provider(_capture, feed_urls=_field(), region={"type": "text"})
    picks = await DataSource.choices_for(name, "feed_urls", {"feed_urls": "x\ny", "region": "eu"})

    assert seen["config"] == {"feed_urls": ["x", "y"], "region": "eu"}
    assert seen["saved"] is False, "asking what you could pick must not write a row"
    assert [(c.id, c.name, c.detail) for c in picks.items] == [("a", "Alpha", "one")]
    assert picks.detail == "", "a list is the whole answer; the sentence is for when it is not"


async def test_the_drivers_are_resolved_even_before_the_first_poll(provider, monkeypatch):
    """The picker runs on a form, which can be opened seconds after a cold start.

    Nothing had imported the driver registry at that point, so `get_driver` answered None
    and every provider reported "this provider can't list options here" — on a driver that
    lists perfectly well. Only a live backend showed it: every test in this file registers
    a driver as a side effect of setting one up.
    """
    from flow_sdk.ingest.driver import DRIVERS

    async def _list(self, source, field):
        return [Choice(id="only", name="Only")]

    name = await provider(_list, feed_urls=_field())
    DRIVERS.unregister(name)                       # the cold-start registry
    assert DRIVERS.get_or_none(name) is None       # precondition

    monkeypatch.setattr(
        "flow_sdk.ingest.spec_registry.refresh_spec_drivers",
        _reregister(DRIVERS, name),
    )
    picks = await DataSource.choices_for(name, "feed_urls")
    assert [c.id for c in picks.items] == ["only"], picks.detail


def _reregister(registry, name: str):
    """Stand in for the real resolve, which reads specs off disk."""
    stub = _StubDriver(name)

    async def _refresh(_name=None):
        registry.register(stub)

    return _refresh


class _StubDriver:
    kind = "datasource.test.stub"

    def __init__(self, name: str):
        self.provider = name

    async def choices(self, source, field):
        return [Choice(id="only", name="Only")]
