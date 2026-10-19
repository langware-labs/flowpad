"""The values: identity on the triple, tagged payloads that restore their class, the event
and page invariants, and the legacy origin lift."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from flow_sdk.sources import (
    ChangePage,
    CloudOrigin,
    DataPage,
    DataSourceEvent,
    EventKind,
    FileData,
    FileItem,
    FeedItemData,
    MessageData,
    MessageItem,
    RecordData,
    RecordItem,
    SourceItemSpec,
    UserProfile,
)
from flow_sdk.sources.values.origin import LEGACY_NAMESPACE

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

ISSUE = CloudOrigin(kind="jira", namespace="acme/issues", key="10042", url="https://acme.atlassian.net/browse/PROJ-7")


def test_identity_is_the_triple_and_url_is_metadata():
    same = CloudOrigin(kind="jira", namespace="acme/issues", key="10042")
    assert ISSUE == same and hash(ISSUE) == hash(same) and len({ISSUE, same}) == 1
    assert ISSUE != CloudOrigin(kind="jira", namespace="other/issues", key="10042")


@pytest.mark.parametrize("field", ["kind", "namespace", "key"])
def test_an_empty_identity_component_is_refused(field):
    with pytest.raises(ValidationError):
        CloudOrigin(**{**ISSUE.model_dump(), field: ""})


def test_a_legacy_origin_lifts_on_read():
    lifted = CloudOrigin.model_validate({"kind": "gmail", "provider": "agent", "external_id": "m1", "url": ""})
    assert (lifted.kind, lifted.namespace, lifted.key, lifted.url) == ("gmail", LEGACY_NAMESPACE, "m1", None)
    scoped = CloudOrigin.model_validate({"kind": "gmail", "external_id": "m1"}, context={"legacy_namespace": "me@x"})
    assert scoped.namespace == "me@x"
    with pytest.raises(ValidationError):  # the current shape gets no tolerance
        CloudOrigin.model_validate({"kind": "gmail", "key": "m1"})


def test_a_tagged_payload_restores_its_class_through_the_base_item():
    item = MessageItem(origin=ISSUE, data=MessageData(text="hi", sender=UserProfile(origin=ISSUE, name="A")))
    dumped = item.model_dump(mode="json")
    assert dumped["data"]["spec_kind"] == "ingest.message"
    loaded = SourceItemSpec.model_validate(dumped)
    assert type(loaded.data) is MessageData and loaded.data.sender.name == "A"
    with pytest.raises(ValidationError):
        SourceItemSpec.model_validate({"origin": ISSUE.model_dump(), "data": {"spec_kind": "no.such.kind"}})


def test_a_concrete_item_accepts_a_plain_dict_for_its_payload():
    file = FileItem(origin=ISSUE, data={"name": "invoice.pdf", "size": 48_000})
    assert isinstance(file.data, FileData) and file.data.size == 48_000
    with pytest.raises(ValidationError):
        FileItem(origin=ISSUE, data={"size": -1})


def test_a_record_round_trips_and_a_feed_entry_is_a_record():
    """A record is its own payload family — the kind it is stored under, and the class a tagged dump
    restores — and a feed entry is one of them."""
    from flow_sdk.ingest.legacy_lift import FEED_KIND, RECORD_KIND, kind_of

    item = RecordItem(origin=ISSUE, data=RecordData(title="PROJ-7", text="Login fails", url=ISSUE.url))
    loaded = SourceItemSpec.model_validate(item.model_dump(mode="json"))
    assert type(loaded.data) is RecordData and loaded.data.title == "PROJ-7"
    assert kind_of(item.data) == RECORD_KIND
    assert issubclass(FeedItemData, RecordData) and kind_of(FeedItemData(title="t")) == FEED_KIND
    with pytest.raises(TypeError):
        kind_of(FileData(name="a.pdf"))  # a file is never a record: it is reflected, not ingested


def test_a_rename_event_carries_its_previous_origin_and_nothing_else_does():
    previous = CloudOrigin(kind="local", namespace="/r", key="old")
    DataSourceEvent(id="e1", kind=EventKind.RENAME, origin=ISSUE, previous_origin=previous)
    with pytest.raises(ValidationError):
        DataSourceEvent(id="e1", kind=EventKind.RENAME, origin=ISSUE)
    with pytest.raises(ValidationError):
        DataSourceEvent(id="e1", kind=EventKind.DELETE, origin=ISSUE, previous_origin=previous)


def test_a_page_cursor_is_never_empty_and_a_change_page_adds_removals():
    assert DataPage(items=()).next_cursor is None
    with pytest.raises(ValidationError):
        DataPage(items=(), next_cursor="")
    page = ChangePage(items=(), removed=(ISSUE,), resume_cursor="tok")
    assert page.removed == (ISSUE,) and page.next_cursor is None
