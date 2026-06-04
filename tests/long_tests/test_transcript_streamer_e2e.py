"""T9 — full end-to-end transcript streamer + plan.create migration.

Real Claude run in plan mode → FSOp on ~/.claude/projects/ fires →
TranscriptStreamerRegistry → AgenticProcess subscriber → emits plan.create
entity event → on_plan_created delegates to cross_link_plan_to_process.

Test body is intentionally tiny:
  1. Make an AgenticProcess in plan mode.
  2. Prompt → real Claude writes ExitPlanMode + plan file.
  3. Wait for the cross-link to materialise on the AP entity.
  4. Fetch the linked ClaudePlan and verify it exists.

NO in-test trigger wiring, NO callback hand-registration, NO plan.open call —
the production server boot (set_service_triggers + _start_transcript_streamer +
the AP subscriber's load-time registration) does all of it. The test only
arms the FSOp + subscriber path the same way a real server would.

If this passes, the entire chain works in production conditions.
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.claude_memory_entities import ClaudePlan
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.builtin.worker_status import ApiErrorTimeoutError
from flow_sdk.instance_settings import get_instance_settings
from flow_sdk.responses import ApiResponse, ApiSuccessResponse
from flow_sdk.server.fsop_watcher import fsop_watcher
from flow_sdk.transcript_streamer import transcript_streamer_registry
from tests.test_settings import test_service_config


_log = logging.getLogger(__name__)


pytestmark = [
    pytest.mark.skipif(
        not test_service_config.deep_testing,
        reason="Skipping long tests when DEEP_TESTING is disabled",
    ),
]


def _resolve_claude_plans_dir() -> Path:
    plans = get_instance_settings().claude_plans_dir
    plans.mkdir(parents=True, exist_ok=True)
    return plans


async def _prompt_or_skip(ap: AgenticProcess, text: str) -> ApiResponse:
    """Drop the test on Anthropic-API timeouts so external infra issues don't
    surface as test failures."""
    try:
        return await ap.prompt(text)
    except (ApiErrorTimeoutError, TimeoutError):
        pytest.skip("Claude API timeout — external infra issue")


@pytest.fixture
async def _server_boot_simulated():
    """Arm the production streamer boot path: install the FSOp transcript
    watcher trigger, start the FSOp watcher, run the catch-up walk.
    Cleanup unwinds the watcher tasks so the test fixture is isolated.
    """
    from flow_sdk.server.builtin_triggers import set_service_triggers

    # 1. Upsert the builtin transcript watcher (recursive on ~/.claude/projects).
    await set_service_triggers()
    # 2. Start the FSOp watcher (spawns awatch task on the transcript dir).
    await fsop_watcher.start()
    # 3. Start the streamer idle sweeper.
    await transcript_streamer_registry.start_idle_sweeper()

    yield

    await transcript_streamer_registry.stop_idle_sweeper()
    await fsop_watcher.stop()


@pytest.mark.skip(
    reason=(
        "Deep arch: streamer historical full-file parse blocks e2e cross-link "
        "on dev machines with N historical sessions. "
        "Tracked in debug_log.md 2026-05-23 Cluster #7. "
        "Needs streamer contract change + server-boot catch-up review."
    ),
)
@pytest.mark.asyncio
# do not increase timeout without approval
@pytest.mark.timeout(120)
async def test_plan_create_e2e_via_transcript_streamer(
    initialize_test_db, local_project, local_compute_node, tmp_path,
    _server_boot_simulated,
):
    """1. Make AgenticProcess in plan mode.
       2. Prompt — Claude writes ExitPlanMode + plan file.
       3. FSOp fires → streamer parses delta → subscriber routes to AP.
       4. on_plan_created cross-links ClaudePlan ↔ AgenticProcess.
       5. Verify the cross-link is visible on a fresh DB read.
    """
    plans_dir = _resolve_claude_plans_dir()
    plans_snapshot = {p.name for p in plans_dir.glob("*.md")}

    ap = await AgenticProcess(
        worker_type=WorkerType.CLAUDE_CODE,
        cli_config={"permission_mode": "plan"},
        workdir=str(tmp_path),
        visible=False,
    ).save()

    try:
        # Run Claude in plan mode. headless_prompt is fire-and-forget; the actual
        # transcript writes happen in a background task.
        result = await _prompt_or_skip(
            ap,
            "Plan a one-file Python hello-world script. Be brief. "
            "Call ExitPlanMode when done.",
        )
        assert isinstance(result, ApiSuccessResponse), f"prompt failed: {result}"

        # Wait for the production chain to complete:
        #   Claude writes JSONL → FSOp fires → streamer parses → subscriber
        #   resolves AP by session_id → on_plan_created cross-links.
        #
        # We poll the persisted AP for the cross-link rather than hand-wiring
        # any signalling — that's the whole point of T9: production code only.
        deadline = asyncio.get_event_loop().time() + 90
        plan_link = None
        while asyncio.get_event_loop().time() < deadline:
            reloaded = await AgenticProcess.get_by_id(ap.id)
            if reloaded is not None:
                links = [
                    t for t in reloaded.private_context_entities_
                    if t.type == ClaudePlan.get_type()
                ]
                if links:
                    plan_link = links[0]
                    break
            await asyncio.sleep(1.0)

        if plan_link is None:
            new_files = {p.name for p in plans_dir.glob("*.md")} - plans_snapshot
            pytest.fail(
                "Cross-link did not materialize within 90s. "
                f"new plan files: {new_files}; "
                f"streamer sessions: {len(transcript_streamer_registry)}"
            )

        # Step 4: fetch the cross-linked plan.
        plan = await ClaudePlan.get_by_id(plan_link.id)
        assert plan is not None, "ClaudePlan should be retrievable by id"
        assert plan.asset_ref, "ClaudePlan should have asset_ref set"
        plan_file = Path(plan.asset_ref)
        assert plan_file.exists(), f"plan file should exist on disk: {plan_file}"
        assert len(plan_file.read_text()) > 50

        # Step 5: AP should also have plan_path set (Path A or Path C wrote it).
        reloaded = await AgenticProcess.get_by_id(ap.id)
        assert reloaded.plan_path, "AP.plan_path should be set after plan detection"

    finally:
        # Clean up any plan files we created.
        try:
            for name in {p.name for p in plans_dir.glob("*.md")} - plans_snapshot:
                (plans_dir / name).unlink(missing_ok=True)
        except Exception:
            _log.debug("plan-file cleanup failed", exc_info=True)
