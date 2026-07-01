"""Tier-2 live parity: a real "build me hello world webapp" run, per worker,
proves the streamed ProcessStatusReport carries EXACTLY the transcript-derived
counters.

Nondeterminism-proof by construction: the model may burn any number of tokens,
but the assertion is field-by-field EQUALITY between the counters the process
emits on the `progress_report` envelope and the counters an independent full
re-parse of the same session transcript computes. Both derive from the one
ground truth (the JSONL the worker wrote), so the comparison is exact.

Gated on DEEP_TESTING; a worker that isn't installed/authed (or an API timeout)
skips rather than fails. Parametrised over claude/codex/copilot via the
vendor-blind `make_process` fixture.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.builtin.worker_status import ApiErrorTimeoutError, WorkerStatus
from flow_sdk.transcript_analyzer.counters import ProcessCounters, ProcessStatusReport
from tests.test_settings import test_service_config

pytestmark = [
    pytest.mark.skipif(
        not test_service_config.deep_testing,
        reason="Skipping long tests when DEEP_TESTING is disabled",
    ),
]

_REPO = Path(__file__).resolve().parents[2]
_WEBAPP_SKILL = _REPO / "flow_sdk" / "core" / "flow" / "instructions" / "claude_skills" / "webapp"


@pytest.mark.asyncio
# do not increase timeout without approval
@pytest.mark.timeout(240)
async def test_status_report_matches_transcript_exactly(
    initialize_test_db, local_project, local_compute_node, tmp_path, make_process, worker_id,
) -> None:
    ap = await make_process(workdir=str(tmp_path), visible=False, pty_mode=False)

    load = await ap.load_skill(str(_WEBAPP_SKILL))
    assert not getattr(load, "is_error", False), f"load_skill(webapp) failed: {load}"

    try:
        await ap.send("build me hello world webapp")
        await ap.wait()
    except (ApiErrorTimeoutError, TimeoutError):
        pytest.skip(f"{worker_id} API timeout — external infra issue")

    # The one ground truth: re-parse the session transcript the worker wrote.
    transcript = ap._load_transcript()
    if transcript is None or not transcript.entries:
        pytest.skip(f"{worker_id}: no transcript produced (worker unavailable?)")

    reference = ProcessCounters.from_transcript(transcript)
    # The run genuinely did work — copilot only reports output tokens, so gate
    # on output specifically to stay vendor-blind.
    assert reference.output_tokens > 0, f"{worker_id}: run produced no output tokens"
    assert reference.assistant_messages > 0

    # Collect what the process EMITS on the progress_report envelope, via the
    # real _emit_status_report path (change-gated, so exactly one push here).
    captured: list[dict] = []

    async def _capture(flow_data: dict) -> None:
        captured.append(flow_data)

    object.__setattr__(ap, "status_report", None)  # force a change so it emits
    ap.emit_flow_data = _capture  # type: ignore[method-assign]
    await ap._emit_status_report(WorkerStatus.COMPLETE)

    assert len(captured) == 1, f"expected one progress_report, got {captured}"
    attrs = captured[0]["attributes"]
    assert attrs["element-type"] == "progress_report"
    assert attrs["kind"] == "process_status"

    streamed = ProcessStatusReport.model_validate(captured[0]["flow_value"]).counters

    # Field-by-field EXACT equality — the whole point of the test.
    assert streamed == reference, (
        f"{worker_id}: streamed counters {streamed} != transcript {reference}"
    )
