"""The ``helpdesk`` source's case in the data source matrix: a hub desk handed to the source as a
transport double, one open ticket in its pool."""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone

from .test_helpdesk_source import DESK, MSG, POOL, TICKET, HelpdeskSource, _Hub


@contextmanager
def case(monkeypatch, tmp_path):
    now = datetime.now(timezone.utc).isoformat()
    fake = _Hub(pool=[{**POOL[0], "updated_at": now}], messages=[{**MSG, "created_date": now, "updated_date": now}])
    monkeypatch.setattr(HelpdeskSource, "build", classmethod(lambda cls, binding: cls(binding, hub=fake)))
    yield {
        "config": {"desk_project_id": DESK},
        "min_items": 1,
        "send": {"to": TICKET, "text": "matrix send"},
    }
