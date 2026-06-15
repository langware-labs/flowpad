"""ANALYSIS-kind pairing: the analysis process becomes the analyzed process's
child and each carries the other in its private context."""

import uuid

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.flowpad_types.enums import ProcessKind

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


async def test_pair_analysis_context_links_both_sides():
    analyzed = AgenticProcess(id=str(uuid.uuid4()), worker_type="claude_code")
    await analyzed.save()

    analysis = AgenticProcess(
        id=str(uuid.uuid4()),
        worker_type="claude_code",
        process_type=ProcessKind.ANALYSIS,
        target_typeid_str=str(analyzed.typeid),
    )
    await analysis.save()

    assert await analysis.pair_analysis_context() is True

    fresh_analysis = await AgenticProcess.get_by_id(analysis.id)
    fresh_analyzed = await AgenticProcess.get_by_id(analyzed.id)

    assert fresh_analysis.parent_type_id == str(analyzed.typeid)
    analysis_ctx = {str(t) for t in fresh_analysis.private_context_entities}
    analyzed_ctx = {str(t) for t in fresh_analyzed.private_context_entities}
    assert str(analyzed.typeid) in analysis_ctx
    assert str(analysis.typeid) in analyzed_ctx


async def test_pair_analysis_context_tolerates_surface_target():
    """Surface-scoped targets (claude_session/<sid>) are not entities — no-op."""
    analysis = AgenticProcess(
        id=str(uuid.uuid4()),
        worker_type="claude_code",
        process_type=ProcessKind.ANALYSIS,
        target_typeid_str=f"claude_session/{uuid.uuid4()}",
    )
    assert await analysis.pair_analysis_context() is False
    assert analysis.parent_type_id is None


async def test_pair_analysis_context_tolerates_missing_target():
    analysis = AgenticProcess(
        id=str(uuid.uuid4()),
        worker_type="claude_code",
        process_type=ProcessKind.ANALYSIS,
        target_typeid_str=f"agentic_process-{uuid.uuid4()}",
    )
    assert await analysis.pair_analysis_context() is False
