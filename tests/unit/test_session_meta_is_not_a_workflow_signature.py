"""``session_meta`` is a generic session envelope, NOT a workflow signature.

The transcript lens used to render its workflow-run summary strip for any
transcript containing a ``MetaEntry(meta_kind="session_meta")``, on the stated
premise that "only the workflow worker emits a session_meta entry". That premise
is false: codex, copilot and opencode all emit one. The strip reads workflow-only
payload fields (``agentCount`` / ``totalTokens`` / ``totalToolCalls`` /
``durationMs``), so over a worker transcript every tile rendered ``0`` — an
authoritative-looking header that was entirely fabricated.

The viewer now gates that strip on ``workerType === 'workflow'``. This test pins
the backend half of the contract — that the marker really is shared — so nobody
re-derives "workflow" from it again.
"""

from __future__ import annotations

import inspect

import pytest

from flow_sdk.transcript_analyzer.entries import MetaEntry

# Every parser that mints the shared envelope marker.
_EMITTERS = ["codex", "copilot", "opencode", "workflow"]


@pytest.mark.parametrize("worker", _EMITTERS)
def test_the_marker_is_shared_not_workflow_exclusive(worker):
    module = __import__(
        f"flow_sdk.transcript_analyzer.parsers.{worker}", fromlist=["*"]
    )
    source = inspect.getsource(module)
    assert "session_meta" in source, (
        f"{worker} no longer mentions session_meta — if a parser stopped emitting "
        "it, re-check the lens gate rather than assuming the marker narrowed"
    )


def test_more_than_one_worker_emits_it():
    """The load-bearing assertion: the marker cannot identify a single worker."""
    emitting = []
    for worker in _EMITTERS:
        module = __import__(
            f"flow_sdk.transcript_analyzer.parsers.{worker}", fromlist=["*"]
        )
        if "session_meta" in inspect.getsource(module):
            emitting.append(worker)
    assert len(emitting) > 1, (
        "session_meta is emitted by only one parser, which would make it a valid "
        f"worker discriminator — got {emitting}"
    )


def test_opencode_step_start_projects_to_the_shared_envelope():
    """opencode's own contribution, asserted directly rather than by grep."""
    from flow_sdk.transcript_analyzer.parsers.opencode import OpenCodeParser

    entries = OpenCodeParser(session_id="ses_x").feed(
        {
            "type": "step_start",
            "timestamp": 1_700_000_000_000,
            "sessionID": "ses_x",
            "part": {"type": "step-start", "messageID": "msg_1"},
        },
        0,
    )
    metas = [e for e in entries if isinstance(e, MetaEntry)]
    assert [m.meta_kind for m in metas] == ["session_meta"]
    # And it carries none of the workflow-summary fields, which is exactly why
    # the mis-gated strip rendered zeros.
    payload = metas[0].payload or {}
    assert not {"agentCount", "totalTokens", "totalToolCalls", "durationMs"} & set(payload)
