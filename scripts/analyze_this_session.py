"""One-shot probe: run TranscriptIndexer + PlanHandler against this very Claude
session and report what happens end-to-end.

Session under analysis: ff041ecd-bdb8-4bc4-b875-959a7913a958
JSONL: ~/.claude/projects/-Users-shlom-Documents-dev-flowpad-oss/<sid>.jsonl

Notable real-world finding: this session was driven through plan-mode
attachments (`"attachment":{"type":"plan_mode",...}`) rather than explicit
`tool_use:ExitPlanMode` lines. The current analyzer only models the
`tool_use` shape, so `AgentTranscriptFile` parses zero ExitPlanModeEntry from
this transcript. The probe surfaces that finding, then exercises the
indexer pipeline end-to-end against a synthetic 2-line transcript whose
tool_use ExitPlanMode carries this session's id and the actual plan path
extracted from the live attachment.
"""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.claude_memory_entities import ClaudePlan
from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.transcript_indexer import TranscriptIndexer
from flow_sdk.fs_store.transcript_indexer.handlers import PlanHandler
from flow_sdk.transcript_analyzer.entries.exit_plan_mode import ExitPlanModeEntry
from flow_sdk.transcript_analyzer.transcript import AgentTranscriptFile

SESSION_ID = "ff041ecd-bdb8-4bc4-b875-959a7913a958"
ENCODED_PROJECT = "-Users-shlom-Documents-dev-flowpad-oss"
JSONL = (
    Path.home() / ".claude" / "projects" / ENCODED_PROJECT / f"{SESSION_ID}.jsonl"
)


def hr(title: str) -> None:
    print()
    print(f"── {title} " + "─" * (80 - len(title) - 4))


def _scan_plan_mode_attachments(jsonl: Path) -> list[dict]:
    """Raw scan for plan_mode / plan_mode_exit attachments — the actual
    shape this session used. Returns the attachment dicts."""
    out: list[dict] = []
    with jsonl.open() as f:
        for line in f:
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            att = obj.get("attachment")
            if isinstance(att, dict) and att.get("type") in (
                "plan_mode", "plan_mode_exit"
            ):
                out.append(att)
    return out


def _write_synthetic_exit_plan_jsonl(
    session_id: str, plan_file_path: str
) -> Path:
    """Compose a 2-line synthetic transcript exercising the analyzer's
    ExitPlanModeEntry shape, carrying this session's actual id + plan path."""
    user_line = {
        "parentUuid": None,
        "isSidechain": False,
        "type": "user",
        "message": {"role": "user", "content": "synth"},
        "uuid": "00000000-0000-4000-8000-0000000000c9",
        "timestamp": "2026-05-21T07:00:00.000Z",
        "userType": "external",
        "entrypoint": "cli",
        "cwd": "/repo",
        "sessionId": session_id,
        "version": "2.1.119",
        "gitBranch": "main",
    }
    plan_line = {
        "parentUuid": "00000000-0000-4000-8000-0000000000c9",
        "isSidechain": False,
        "type": "assistant",
        "message": {
            "model": "claude-opus-4-7",
            "id": "msg_synth_plan",
            "type": "message",
            "role": "assistant",
            "content": [{
                "type": "tool_use",
                "id": "toolu_synth_plan",
                "name": "ExitPlanMode",
                "input": {"plan": "synth", "planFilePath": plan_file_path},
            }],
            "stop_reason": "tool_use",
        },
        "requestId": "req_synth",
        "uuid": "00000000-0000-4000-8000-0000000003e9",
        "timestamp": "2026-05-21T07:01:00.000Z",
        "userType": "external",
        "entrypoint": "cli",
        "cwd": "/repo",
        "sessionId": session_id,
        "version": "2.1.119",
        "gitBranch": "main",
        "slug": "synth-plan",
    }
    tmp_dir = Path(tempfile.mkdtemp(prefix="probe_synth_"))
    proj_dir = tmp_dir / ".claude" / "projects" / "synth"
    proj_dir.mkdir(parents=True, exist_ok=True)
    out = proj_dir / f"{session_id}.jsonl"
    out.write_text(
        json.dumps(user_line) + "\n" + json.dumps(plan_line) + "\n",
        encoding="utf-8",
    )
    return out


async def main() -> int:
    assert JSONL.exists(), f"missing transcript: {JSONL}"

    # ── 1. Analyzer probe over the real session JSONL ───────────────────────
    hr("Step 1 — AgentTranscriptFile probe over the real session JSONL")
    transcript = AgentTranscriptFile("claude", JSONL)
    exit_plans = [e for e in transcript.entries if isinstance(e, ExitPlanModeEntry)]
    print(f"transcript path:       {JSONL}")
    print(f"transcript entries:    {len(transcript.entries)}")
    print(f"tool_use ExitPlanMode: {len(exit_plans)}")
    print(f"AgentTranscriptFile.session_id: {transcript.session_id}")

    # ── 1b. Raw scan: this session used plan_mode attachments ──────────────
    hr("Step 1b — raw plan_mode attachment scan (not yet parsed by analyzer)")
    attachments = _scan_plan_mode_attachments(JSONL)
    print(f"plan_mode/plan_mode_exit attachments: {len(attachments)}")
    plan_paths: list[str] = []
    for a in attachments[:3]:
        pfp = a.get("planFilePath", "")
        print(f"  type={a.get('type')!r:20s} planExists={a.get('planExists')}  planFilePath={pfp}")
        if pfp:
            plan_paths.append(pfp)
    if not plan_paths:
        print("no planFilePath in attachments — cannot proceed")
        return 1
    plan_path = plan_paths[-1]
    assert Path(plan_path).exists(), f"plan file missing on disk: {plan_path}"

    # ── 2. Seed an AgenticProcess for this session ─────────────────────────
    hr("Step 2 — seed AgenticProcess for SESSION_ID; leave Plan to handler")
    procs = await AgenticProcess.get_all(
        entities_filter=QueryFilter(match=ExpressionNode(session_id=SESSION_ID))
    )
    if procs:
        proc = procs[0]
        print(f"AgenticProcess: existing  id={proc.id}")
    else:
        proc = AgenticProcess(id=str(uuid.uuid4()), session_id=SESSION_ID)
        await proc.save()
        print(f"AgenticProcess: created   id={proc.id}")

    pre_plan = await ClaudePlan.get_one({"asset_ref": plan_path})
    print(
        "ClaudePlan (pre):  "
        + (f"existing id={pre_plan.id}" if pre_plan else "missing — handler will reindex")
    )

    # ── 3. Run TranscriptIndexer over a synthetic JSONL that exercises the
    #     analyzer-shaped ExitPlanMode path, using the real session id +
    #     real plan path discovered above.
    hr("Step 3 — TranscriptIndexer over a synthetic ExitPlanMode transcript")
    synth_jsonl = _write_synthetic_exit_plan_jsonl(SESSION_ID, plan_path)
    print(f"synthetic JSONL: {synth_jsonl}")

    ti = TranscriptIndexer()
    ti.add_handler(PlanHandler())
    await ti(
        [FSRef(synth_jsonl, record_type=RecordType.CLAUDE_SESSION)],
        IndexerOptions(verbose=False, force=True),
    )
    print("dispatch complete")

    # ── 4. Verify cross-links on both sides ────────────────────────────────
    hr("Step 4 — verify cross-link in private_context_entities on both sides")
    plan = await ClaudePlan.get_one({"asset_ref": plan_path})
    if plan is None:
        print("ClaudePlan: STILL MISSING after handler — scoped PLAN reindex failed")
        return 1
    print(f"ClaudePlan:      id={plan.id}")
    print(f"  asset_ref:        {plan.asset_ref}")
    plan_links = [(t.type, t.id) for t in plan.private_context_entities_]
    print(f"  private_context_entities_: {plan_links}")

    proc_reloaded = await AgenticProcess.get_by_id(proc.id)
    assert proc_reloaded is not None
    proc_links = [(t.type, t.id) for t in proc_reloaded.private_context_entities_]
    print(f"AgenticProcess:  id={proc_reloaded.id}")
    print(f"  session_id:       {proc_reloaded.session_id}")
    print(f"  private_context_entities_: {proc_links}")

    expected_on_plan = (AgenticProcess.get_type(), proc.id)
    expected_on_proc = (ClaudePlan.get_type(), plan.id)
    plan_ok = expected_on_plan in plan_links
    proc_ok = expected_on_proc in proc_links

    hr("Result")
    print(f"1. plan detected (analyzer tool_use shape): {len(exit_plans) > 0}")
    print(f"   plan detected (raw plan_mode attachment): {len(attachments) > 0}")
    print(f"2. entities present:  Plan={plan is not None}  AgenticProcess={proc_reloaded is not None}")
    print(f"3. cross-link plan -> agentic_process: {'OK' if plan_ok else 'MISSING'}")
    print(f"   cross-link agentic_process -> plan: {'OK' if proc_ok else 'MISSING'}")
    return 0 if (plan_ok and proc_ok) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
