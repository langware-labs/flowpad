"""A Claude run names the model that answered, even when Flowpad did not pick it.

An API-key or endpoint run is stamped with its model before spawn. A DEVICE login (Claude's own
subscription) never was: on the clean-Windows VM every wizard agent finished with
``resolved_model_slug`` empty, and the model (Haiku) could be read only out of Claude's transcript.
The turn's end now fills it from that transcript — and only when nothing else named it.
"""

from __future__ import annotations

import json

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.claude.driver import _fill_resolved_model_slug

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


class _Process:
    id = "proc-1"

    def __init__(self, slug=None):
        self.resolved_model_slug = slug
        self.saves = 0

    async def save(self):
        self.saves += 1


def _transcript(tmp_path, *models):
    path = tmp_path / "session.jsonl"
    lines = [json.dumps({"type": "user", "message": {"content": "hi"}})]
    lines += [json.dumps({"type": "assistant", "message": {"model": m, "content": []}}) for m in models]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


@pytest.mark.asyncio
async def test_a_device_login_run_records_the_model_that_answered(tmp_path):
    process = _Process()

    await _fill_resolved_model_slug(process, _transcript(tmp_path, "claude-haiku-4-5-20251001", "<synthetic>"))

    assert process.resolved_model_slug == "claude-haiku-4-5-20251001"
    assert process.saves == 1


@pytest.mark.asyncio
async def test_a_slug_stamped_before_spawn_is_kept(tmp_path):
    """An endpoint's own slug says more than the transcript's bare model name."""
    process = _Process("openrouter/anthropic/claude-sonnet-5")

    await _fill_resolved_model_slug(process, _transcript(tmp_path, "claude-sonnet-5"))

    assert process.resolved_model_slug == "openrouter/anthropic/claude-sonnet-5" and process.saves == 0


@pytest.mark.asyncio
async def test_no_transcript_or_no_answer_leaves_it_empty(tmp_path):
    process = _Process()

    await _fill_resolved_model_slug(process, None)
    await _fill_resolved_model_slug(process, tmp_path / "missing.jsonl")
    await _fill_resolved_model_slug(process, _transcript(tmp_path, "<synthetic>"))

    assert process.resolved_model_slug is None and process.saves == 0
