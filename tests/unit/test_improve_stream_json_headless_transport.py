"""Regression: the Improve-asset run hung because its worker was created with
an interactive-PTY transport despite requesting headless ``stream-json`` output.

The Improve launcher (ui/.../skill-eval-analysis.ts ``runSkillWorker``) posts a
createProcess request whose context sets ``output_format='stream-json'`` but
carries NO ``pty_mode``. The documented contract (ts_sdk agentic-context.ts:94-95)
is: ``stream-json`` ⇒ print-mode, NO PTY. But the backend action defaults
``pty_mode=True`` when omitted, so the process is born PTY-transport. Its first
queued prompt then never drains — ``_queue_ready`` withholds cold-start from a
PTY process (headless-only) — and the run hangs at status=new forever.

This test drives the REAL ``_scan_create_process`` action with the exact request
the Improve button sends, constructs a REAL ``AgenticProcess``, and asserts the
created process honours the stream-json headless contract (so its first prompt
would drain). Only the persistence/request boundaries are patched — never the
transport decision under test.

Guards the invariant that a stream-json create request yields a headless,
drainable process (before the fix it was born PTY-transport and hung).
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.faas.compute_node import ComputeNode
from flow_sdk.builtin.process_lifecycle import ProcessStatus

_PATCH_REQ_SCAN = "flow_sdk.builtin.faas.scan_actions.get_current_request_info"


def _improve_request_info(body: dict):
    from unittest.mock import MagicMock

    info = MagicMock()
    info.someone_typeid = None
    info.request = MagicMock()
    info.get_post_data = AsyncMock(return_value=body)
    return info


@pytest.mark.asyncio
async def test_stream_json_create_request_yields_headless_drainable_process(monkeypatch) -> None:
    node = ComputeNode()

    # The exact request the Improve launcher posts: headless stream-json output,
    # analysis kind, no pty_mode key at all.
    info = _improve_request_info(
        {
            "context": {
                "output_format": "stream-json",
                "permission_mode": "bypassPermissions",
                "process_type": "analysis",
            },
            "visible": False,
        }
    )

    # Capture the REAL constructed process; patch only persistence boundaries.
    saved: dict = {}

    async def _capture_save(self, owner=None, notify: bool = True):
        saved["proc"] = self

    monkeypatch.setattr(_PATCH_REQ_SCAN.rsplit(".", 1)[0] + ".get_current_request_info", lambda: info, raising=True)
    monkeypatch.setattr(AgenticProcess, "save", _capture_save, raising=True)
    monkeypatch.setattr(AgenticProcess, "pair_analysis_context", AsyncMock(return_value=True), raising=True)
    # The create path pre-flights the harness before constructing anything. This
    # test is about transport selection, not about what the runner has on disk —
    # left real it asserts "a Claude CLI is installed", which is true on a dev
    # machine and false on CI.
    monkeypatch.setattr(AgenticProcess, "is_installed", AsyncMock(return_value=True), raising=True)

    resp = await node._scan_create_process()
    assert resp.status == "SUCCESS", getattr(resp, "message", resp)

    proc = saved["proc"]
    assert proc.status == ProcessStatus.NEW.value
    assert resp.data["id"] == proc.id
    assert resp.data["type"] == proc.type
    assert resp.data["pty_mode"] is False
    assert resp.data["visible"] is False
    assert "pty_pid" in resp.data

    # The documented contract: a stream-json process is headless (no PTY), so its
    # first queued prompt can cold-start/drain. Without the guard, pty_mode
    # defaulted True and the improve run hung at status=new forever.
    assert proc.pty_mode is False, (
        "stream-json output requested but process born with PTY transport "
        f"(pty_mode={proc.pty_mode}) — violates the headless contract"
    )
    assert proc._queue_ready(None) is True, (
        "fresh stream-json process is not drainable — its first prompt would never inject (the hang)"
    )
