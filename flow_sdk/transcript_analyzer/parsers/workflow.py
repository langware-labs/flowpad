"""Claude Code **workflow run** journal parser.

A workflow run is NOT a line-delimited transcript — the provider writes a single
JSON object per run at ``workflows/wf_<runId>.json`` (the "journal"/ledger). This
parser is ``whole_document`` (see :class:`Parser`): ``AgentTranscriptFile`` reads
the entire file once and calls :meth:`feed` a single time with the parsed object.

The journal is mapped onto EXISTING transcript entry kinds — no new entry type:

* the run envelope → one ``MetaEntry(meta_kind="session_meta")`` (so the generic
  transcript route's header scan finds it);
* each ``workflowProgress`` ``workflow_phase`` row → ``MetaEntry("workflow_phase")``;
* each ``workflow_agent`` row → an ``AgentSpawnEntry`` (``EntryKind.AGENT_SPAWN``) —
  the same "this execution spawned a child" call-site entry Claude's ``Task`` tool
  produces. ``tool_use_id`` carries the child ``agentId``; the spawned agent's own
  transcript lives at ``subagents/workflows/<runId>/agent-<agentId>.jsonl`` (a plain
  Claude transcript, parsed by ``ClaudeParser``).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from ..entries import AgentSpawnEntry, MetaEntry
from ..entry import TranscriptEntry


def _ms_to_iso(ms: Any) -> str:
    """Epoch-millis → ISO-8601 (UTC, ``Z``). Empty string for non-numeric input,
    so entry ordering by ``timestamp`` stays string-comparable with claude/codex."""
    if not isinstance(ms, (int, float)):
        return ""
    try:
        return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()
    except (ValueError, OverflowError, OSError):
        return ""


class WorkflowParser:
    worker_type = "workflow"
    # The journal is a single JSON document, not JSONL — AgentTranscriptFile reads
    # the whole file and feeds the parsed object once. See transcript._read_whole_document.
    whole_document = True

    def __init__(self, session_id: str = "") -> None:
        self.session_id = session_id

    def feed(self, raw: dict, line_index: int) -> list[TranscriptEntry]:
        if not isinstance(raw, dict):
            return []
        run_id = str(raw.get("runId") or "")
        if run_id and not self.session_id:
            self.session_id = run_id
        sid = self.session_id or run_id

        def _base(eid: str, timestamp: str = "") -> dict:
            return dict(id=eid, session_id=sid, timestamp=timestamp, worker=self.worker_type)

        out: list[TranscriptEntry] = []

        # Run envelope — session_meta so the route header scan (transcripts._build_header)
        # and AgentTranscriptFile.to_string surface it like every other worker.
        out.append(MetaEntry(
            meta_kind="session_meta",
            payload={
                "runId": run_id,
                "workflowName": raw.get("workflowName"),
                "status": raw.get("status"),
                "agentCount": raw.get("agentCount"),
                "totalTokens": raw.get("totalTokens"),
                "totalToolCalls": raw.get("totalToolCalls"),
                "durationMs": raw.get("durationMs"),
                "model_provider": raw.get("defaultModel"),
            },
            **_base(f"{sid or 'workflow'}:meta", str(raw.get("timestamp") or "")),
        ))

        progress = raw.get("workflowProgress")
        if not isinstance(progress, list):
            progress = []
        phases = [p for p in progress if isinstance(p, dict) and p.get("type") == "workflow_phase"]
        agents = [p for p in progress if isinstance(p, dict) and p.get("type") == "workflow_agent"]

        def _phase_entry(item: dict) -> MetaEntry:
            idx = item.get("index")
            return MetaEntry(
                meta_kind="workflow_phase",
                payload={"index": idx, "title": item.get("title")},
                **_base(f"{sid}:phase:{idx}"),
            )

        def _agent_entry(item: dict) -> AgentSpawnEntry:
            agent_id = str(item.get("agentId") or "") or f"{sid}:agent:{item.get('index')}"
            return AgentSpawnEntry(
                agent_type=str(item.get("label") or item.get("agentType") or ""),
                prompt=item.get("promptPreview"),
                description=item.get("label"),
                tool_name="Workflow",
                tool_use_id=agent_id,
                model=str(item.get("model") or "") or None,
                **_base(agent_id, _ms_to_iso(item.get("startedAt"))),
            )

        # The journal lists all phases first, then all agents (each tagged with
        # phaseIndex). Regroup so each phase divider is followed by its own
        # agents — a faithful regroup via the journal's phaseIndex linkage, so
        # the stream reads as agents grouped under their phase. Bucket agents by
        # phaseIndex in one pass; agents with no matching phase trail at the end.
        if not phases:
            return out + [_agent_entry(ag) for ag in agents]
        phase_indices = {ph.get("index") for ph in phases}
        by_phase: dict = {}
        orphans: list = []
        for ag in agents:
            idx = ag.get("phaseIndex")
            (by_phase.setdefault(idx, []) if idx in phase_indices else orphans).append(ag)
        for ph in phases:
            out.append(_phase_entry(ph))
            out.extend(_agent_entry(ag) for ag in by_phase.get(ph.get("index"), []))
        out.extend(_agent_entry(ag) for ag in orphans)
        return out
