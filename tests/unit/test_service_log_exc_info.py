"""``service_log.warn/error(..., exc_info=True)`` carry the traceback, the way
``logging`` does — two call sites passed it before the facade accepted it and
died a second time inside their own ``except``."""
from __future__ import annotations

import logging

import pytest

from flow_sdk import service_log


@pytest.mark.parametrize("emit", [service_log.warn, service_log.warning, service_log.error])
def test_exc_info_appends_the_traceback(emit, caplog, monkeypatch):
    monkeypatch.setattr(service_log, "console", None)
    with caplog.at_level(logging.DEBUG):
        try:
            raise RuntimeError("the reason")
        except RuntimeError:
            emit("setup failed", exc_info=True)
    assert "setup failed" in caplog.text and "RuntimeError: the reason" in caplog.text
