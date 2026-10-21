"""Listing a source previews bodies without claiming the stored record is truncated."""
import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.source_item import SourceItem


@pytest.mark.parametrize("length", [0, 500, 501])
async def test_preview_reports_full_length_and_keeps_full_record(length):
    source = DataSource(name=f"preview-{mint_uuid()}", provider="rss", config={"feed_url": "https://example.test/feed"})
    await source.save()
    body = "é" * length
    item = SourceItem(data_source_id=source.id, provider="rss", kind="content.feed.item",
                      external_id="message", name="Subject with its own ellipsis...", body=body)
    await item.save()

    rows = await source.recent_items()
    assert len(rows) == 1
    preview = rows[0]
    assert preview["name"] == item.name, "subject ellipses are source content, not body truncation"
    assert preview["body"] == body[:500]
    assert preview["body_truncated"] is (length > 500)
    assert preview["full_body_length"] == length
    assert preview["full_record_path"] == f"/api/v1/graph/source_item/{item.id}"
    assert (await SourceItem.get_by_id(item.id)).body == body


def test_items_help_full_record_example_uses_available_instance_transport(monkeypatch):
    from flow_sdk.cli.commands import _common, source_cmd

    command = next(c for c in source_cmd.source_app.registered_commands if c.name == 'items')
    example = command.help.split('\b\n', 1)[1]
    calls = []
    expected = {'name': 'Original...', 'body': 'complete body'}
    monkeypatch.setattr(_common, 'discover_port', lambda: 49123)

    def capture(url, *, on_error):
        calls.append(url)
        assert on_error is _common.server_error
        return expected

    monkeypatch.setattr(_common, 'get_graph_json', capture)
    scope = {}
    exec(compile(example, '<source items help>', 'exec'), scope)
    assert calls == ['http://127.0.0.1:49123/api/v1/graph/source_item/ITEM_ID']
    assert scope['record'] == expected
    assert 'name is complete' in command.help
    assert 'only body is previewed' in command.help
