"""Fixtures shared by the diskio kit."""
from __future__ import annotations

import pytest

from flow_sdk.diskio import select


@pytest.fixture
def selector(monkeypatch):
    """A private copy of the selector's state, so a test can register or break a backend."""
    monkeypatch.setattr(select, "_FACTORIES", {piece: dict(by) for piece, by in select._FACTORIES.items()})
    monkeypatch.setattr(select, "_INSTANCES", {})
    monkeypatch.setattr(select, "_UNAVAILABLE", set())
    monkeypatch.setattr(select, "_warned", False)
    return monkeypatch
