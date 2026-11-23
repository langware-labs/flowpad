"""``flow source create``: a message channel is the person's, so only a NAMED project places it."""
from __future__ import annotations

import pytest

from flow_sdk.cli.commands import _common

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

DRIVERS = [{"name": "chat", "sends": True}, {"name": "feed", "sends": False}]


@pytest.fixture
def last_active_project(monkeypatch, tmp_path):
    """An instance whose last used project is ``p1``; the working directory is no project."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(_common, "project_for_path", lambda *a, **k: None)
    monkeypatch.setattr(
        _common, "get_graph_json", lambda url, **k: DRIVERS if url.endswith("data_driver") else {"project_id": "p1"}
    )


@pytest.mark.parametrize(
    ("provider", "named", "path"),
    [
        ("chat", None, "data_source"),
        ("chat", "p2", "project/p2/data_source"),
        ("feed", None, "project/p1/data_source"),
    ],
)
def test_only_a_named_project_places_a_message_channel(last_active_project, provider, named, path):
    assert _common.data_source_create_path(1, named, provider) == path
