"""Deterministic usage analysis over a date range.

``analyze_usage(start, end)`` is pure: it reads on-disk Claude session JSONLs and
returns aggregates + a per-session drill-down spine. No DB, no network, no LLM.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from flow_sdk.fs_store.indexer.functions.claude_sessions import (
    claude_session_start_time,
    discover_claude_session_paths_iter,
    ensure_claude_session_stats,
    extract_claude_session_from_path,
)
from flow_sdk.transcript_analyzer import (
    AgentTranscriptFile,
    EntryKind,
    ToolResultEntry,
)
from flow_sdk.transcript_analyzer.assembly import assemble_tree
from flow_sdk.transcript_analyzer.pricing import pricing_for

# How many distinct entries to keep in each "top N" breakdown / sample list.
_TOP_N = 8
_SAMPLE_PROMPTS = 5
_PROMPT_PREVIEW_CHARS = 160


@dataclass
class SessionRow:
    """One session's slice of the report — the drill-down spine.

    ``session_id`` is enough for the UI to deep-link the raw transcript / call
    stack at ``/dock/lens/claude/transcript/<session_id>``. ``agent_trace_id`` is
    populated best-effort by the persisting layer when an AgentTrace exists.
    """

    session_id: str
    title: str
    cwd: str
    project: str  # basename of cwd — a short, human label
    start: Optional[str]  # ISO timestamp
    duration_ms: int = 0
    cost_usd: float = 0.0
    total_tokens: int = 0
    prompt_count: int = 0
    skills: list[str] = field(default_factory=list)
    agents: list[str] = field(default_factory=list)
    tool_failures: int = 0
    agent_trace_id: Optional[str] = None


@dataclass
class UsageReportData:
    """Aggregated usage over ``[period_start, period_end)``."""

    period_start: str
    period_end: str
    period_kind: str  # "day" | "week" | "month" | "range"
    generated_at: str

    # Headline
    total_cost_usd: float = 0.0
    session_count: int = 0
    total_duration_ms: int = 0
    total_tokens: int = 0

    # Token split + efficiency
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0
    cache_hit_rate: float = 0.0  # cache_read / (input + cache_read)

    # Activity
    prompt_count: int = 0
    skill_invocations: int = 0
    agent_spawns: int = 0

    # Breakdowns: list[{name/type/model, count/cost}]
    top_skills: list[dict] = field(default_factory=list)
    top_agents: list[dict] = field(default_factory=list)
    top_tools: list[dict] = field(default_factory=list)
    models: list[dict] = field(default_factory=list)
    sample_prompts: list[str] = field(default_factory=list)

    # Highlights (session ids) + the drill-down spine
    busiest_session_id: Optional[str] = None
    most_expensive_session_id: Optional[str] = None
    sessions: list[SessionRow] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    """Parse an ISO timestamp to an aware datetime (UTC if naive)."""
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _in_window(ts: Optional[str], start: datetime, end: datetime) -> bool:
    """True iff ISO timestamp ``ts`` falls in ``[start, end)`` (per-event bucketing)."""
    dt = _parse_iso(ts)
    return dt is not None and start <= dt < end


def _session_start(rec) -> Optional[datetime]:
    created = getattr(rec, "created_at", None)
    dt = _parse_iso(created)
    if dt is None:
        dt = _parse_iso(claude_session_start_time(rec))
    return dt


def analyze_usage(start: datetime, end: datetime) -> UsageReportData:
    """Aggregate Claude usage for sessions started in ``[start, end)``.

    ``start``/``end`` should be timezone-aware; naive values are treated as UTC.
    The function is read-only and deterministic.

    Scope: v1 analyzes Claude sessions only. Codex/Copilot use the same
    worker-generic ``AgentTranscriptFile`` interface, so a multi-worker variant
    would generalize ``discover_claude_session_paths_iter`` rather than this loop.
    """
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)

    period_days = (end - start).days
    if period_days <= 1:
        period_kind = "day"
    elif period_days <= 7:
        period_kind = "week"
    elif period_days <= 31:
        period_kind = "month"
    else:
        period_kind = "range"

    data = UsageReportData(
        period_start=start.isoformat(),
        period_end=end.isoformat(),
        period_kind=period_kind,
        generated_at=datetime.now(timezone.utc).isoformat(),
    )

    skill_counter: Counter[str] = Counter()
    agent_counter: Counter[str] = Counter()
    tool_counter: Counter[str] = Counter()
    model_cost: Counter[str] = Counter()
    sample_prompts: list[str] = []

    for path in discover_claude_session_paths_iter():
        # Cheap overlap pre-gate. A session contributes to this window iff some of
        # its activity lands inside it, so we keep any session that *could* overlap
        # and let the per-event filter below decide. Skip only sessions that
        # provably can't: started at/after `end`, or last written before `start`.
        try:
            rec = extract_claude_session_from_path(path, include_content=False)
        except Exception:  # noqa: BLE001 — a single unreadable session must not abort the run
            continue
        started = _session_start(rec)
        if started is not None and started >= end:
            continue
        try:
            last_activity = datetime.fromtimestamp(Path(path).stat().st_mtime, tz=timezone.utc)
        except OSError:
            last_activity = None
        if last_activity is not None and last_activity < start:
            continue

        # Single source of truth for cost + tokens: the transcript analyzer.
        # `usage_deep()` is deduped by message id (Claude rewrites each assistant
        # message 2-3× in the JSONL) and split per cache tier; we then bucket each
        # entry by its OWN timestamp so a multi-day session lands on the right day
        # — matching ccusage's per-event day accounting. The headline
        # `_estimate_cost` estimator (no dedup, flat 5m cache) is never used here.
        try:
            transcript = AgentTranscriptFile("claude", Path(path))
            # Stitch sub-agent transcripts (`<sid>/subagents/agent-*.jsonl`) onto
            # their spawn so `usage_deep()` includes them. They live in a subdir
            # the session glob never sees, and hold all Explore/Haiku + sub-agent
            # cost — without this the day total is short by every sub-agent token.
            try:
                assemble_tree(transcript)
            except Exception:  # noqa: BLE001 — assembly is best-effort
                pass
            usage_in = [e for e in transcript.usage_deep() if _in_window(e.timestamp, start, end)]
            prompts_in = [p for p in transcript.prompts if _in_window(p.timestamp, start, end)]
            entries_in = [e for e in transcript.entries if _in_window(e.timestamp, start, end)]
        except Exception:  # noqa: BLE001 — transcript parse is best-effort
            continue

        if not usage_in and not prompts_in:
            continue  # nothing inside the window

        # One pass over the (deduped, in-window) usage entries → total cost,
        # per-model cost, and the per-cache-tier token split. Cost is resolved
        # per entry by model + cache tier via the analyzer's price tables, never
        # the headline `_estimate_cost` estimator (no dedup, flat 5m cache, no
        # sub-agents). "<synthetic>" / other non-model markers carry ~no usage,
        # so we drop them from the per-model breakdown (the old uniform split
        # mis-attributed ~a quarter of the total to them).
        cost = 0.0
        in_tok = out_tok = cache_read = cache_creation = 0
        for e in usage_in:
            entry_cost = pricing_for(e.model, "claude").cost_of(e)
            cost += entry_cost
            model = str(e.model or "")
            if model and not model.startswith("<"):
                model_cost[model] += entry_cost
            if e.io == "output":
                out_tok += e.count
            elif e.io == "input":
                if e.cache == "none":
                    in_tok += e.count
                elif e.cache == "read":
                    cache_read += e.count
                elif e.cache == "write":
                    cache_creation += e.count
        sess_tokens = in_tok + out_tok + cache_read + cache_creation

        # Activity tallies — in-window entries only.
        skills: list[str] = []
        agents: list[str] = []
        tool_failures = 0
        for e in entries_in:
            kind = e.kind
            if kind is EntryKind.SKILL_CALL:
                skills.append(e.skill_name)
                skill_counter[e.skill_name] += 1
            elif kind is EntryKind.AGENT_SPAWN:
                agents.append(e.agent_type)
                agent_counter[e.agent_type] += 1
            elif kind is EntryKind.TOOL_USE:
                if getattr(e, "tool_name", None):
                    tool_counter[e.tool_name] += 1
            elif isinstance(e, ToolResultEntry) and e.is_error:
                tool_failures += 1

        prompt_count = len(prompts_in)
        for p in prompts_in:
            if len(sample_prompts) < _SAMPLE_PROMPTS and p.text:
                sample_prompts.append(p.text.strip()[:_PROMPT_PREVIEW_CHARS])

        # Duration is a soft whole-session metric (not splittable per message).
        try:
            ensure_claude_session_stats(rec)
        except Exception:  # noqa: BLE001
            pass
        duration = int(getattr(rec, "duration_ms", 0) or 0)

        cwd = str(getattr(rec, "cwd", "") or "")
        row = SessionRow(
            session_id=str(getattr(rec, "session_id", "") or path.stem),
            title=str(getattr(rec, "name", "") or ""),
            cwd=cwd,
            project=Path(cwd).name if cwd else "",
            start=started.isoformat() if started else None,
            duration_ms=duration,
            cost_usd=round(cost, 4),
            total_tokens=sess_tokens,
            prompt_count=prompt_count,
            skills=sorted(set(skills)),
            agents=sorted(set(agents)),
            tool_failures=tool_failures,
        )
        data.sessions.append(row)

        # Aggregate headline.
        data.total_cost_usd += cost
        data.total_duration_ms += duration
        data.input_tokens += in_tok
        data.output_tokens += out_tok
        data.cache_read_tokens += cache_read
        data.cache_creation_tokens += cache_creation
        data.prompt_count += prompt_count

    # Finalize.
    data.session_count = len(data.sessions)
    data.total_cost_usd = round(data.total_cost_usd, 4)
    data.total_tokens = (
        data.input_tokens + data.output_tokens
        + data.cache_read_tokens + data.cache_creation_tokens
    )
    cache_denom = data.input_tokens + data.cache_read_tokens
    data.cache_hit_rate = round(data.cache_read_tokens / cache_denom, 4) if cache_denom else 0.0
    data.skill_invocations = sum(skill_counter.values())
    data.agent_spawns = sum(agent_counter.values())

    data.top_skills = [{"name": n, "count": c} for n, c in skill_counter.most_common(_TOP_N)]
    data.top_agents = [{"type": n, "count": c} for n, c in agent_counter.most_common(_TOP_N)]
    data.top_tools = [{"name": n, "count": c} for n, c in tool_counter.most_common(_TOP_N)]
    data.models = [
        {"model": m, "cost_usd": round(c, 4)} for m, c in model_cost.most_common(_TOP_N)
    ]
    data.sample_prompts = sample_prompts

    if data.sessions:
        data.busiest_session_id = max(
            data.sessions, key=lambda s: (s.prompt_count, s.duration_ms)
        ).session_id
        data.most_expensive_session_id = max(
            data.sessions, key=lambda s: s.cost_usd
        ).session_id

    return data


def _fmt_duration(ms: int) -> str:
    secs = ms // 1000
    h, rem = divmod(secs, 3600)
    m, _ = divmod(rem, 60)
    if h:
        return f"{h}h {m}m"
    return f"{m}m"


def _fmt_tokens(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return str(n)


def render_markdown(data: UsageReportData) -> str:
    """Render a concise, drillable markdown report from the aggregates.

    Headline → breakdown tables → a per-session table whose rows deep-link the
    raw transcript / call-stack view (``/dock/lens/claude/transcript/<id>``).
    """
    start = _parse_iso(data.period_start)
    label = start.strftime("%Y-%m-%d") if start else data.period_start
    lines: list[str] = []
    lines.append(f"# Usage report — {label} ({data.period_kind})")
    lines.append("")
    lines.append(
        f"**${data.total_cost_usd:.2f}** · **{data.session_count}** sessions · "
        f"**{_fmt_duration(data.total_duration_ms)}** active · "
        f"**{_fmt_tokens(data.total_tokens)}** tokens · "
        f"**{data.prompt_count}** prompts"
    )
    lines.append("")

    # Tokens / efficiency
    lines.append("## Tokens")
    lines.append("| dimension | tokens |")
    lines.append("| --- | --- |")
    lines.append(f"| input | {_fmt_tokens(data.input_tokens)} |")
    lines.append(f"| output | {_fmt_tokens(data.output_tokens)} |")
    lines.append(f"| cache read | {_fmt_tokens(data.cache_read_tokens)} |")
    lines.append(f"| cache write | {_fmt_tokens(data.cache_creation_tokens)} |")
    lines.append(f"| cache hit rate | {data.cache_hit_rate * 100:.0f}% |")
    lines.append("")

    if data.top_skills:
        lines.append("## Top skills")
        lines.append("| skill | uses |")
        lines.append("| --- | --- |")
        for s in data.top_skills:
            lines.append(f"| {s['name']} | {s['count']} |")
        lines.append("")

    if data.top_agents:
        lines.append("## Agents spawned")
        lines.append("| agent | spawns |")
        lines.append("| --- | --- |")
        for a in data.top_agents:
            lines.append(f"| {a['type']} | {a['count']} |")
        lines.append("")

    if data.top_tools:
        lines.append("## Top tools")
        lines.append("| tool | calls |")
        lines.append("| --- | --- |")
        for t in data.top_tools:
            lines.append(f"| {t['name']} | {t['count']} |")
        lines.append("")

    if data.models:
        lines.append("## Models")
        lines.append("| model | cost |")
        lines.append("| --- | --- |")
        for m in data.models:
            lines.append(f"| {m['model']} | ${m['cost_usd']:.2f} |")
        lines.append("")

    if data.sample_prompts:
        lines.append("## Sample prompts")
        for p in data.sample_prompts:
            lines.append(f"- {p}")
        lines.append("")

    # Per-session drill-down table.
    if data.sessions:
        lines.append("## Sessions")
        lines.append("| session | cost | time | prompts | skills | agents | open |")
        lines.append("| --- | --- | --- | --- | --- | --- | --- |")
        for s in sorted(data.sessions, key=lambda r: r.cost_usd, reverse=True):
            title = (s.title or s.session_id[:8]).replace("|", "\\|")
            link = f"[transcript](/dock/lens/claude/transcript/{s.session_id})"
            lines.append(
                f"| {title} | ${s.cost_usd:.2f} | {_fmt_duration(s.duration_ms)} | "
                f"{s.prompt_count} | {len(s.skills)} | {len(s.agents)} | {link} |"
            )
        lines.append("")

    return "\n".join(lines)
