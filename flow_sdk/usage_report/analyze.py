"""Deterministic usage analysis over a date range.

``analyze_usage(start, end)`` is pure: it reads on-disk Claude session JSONLs and
returns aggregates + a per-session drill-down spine. No DB, no network, no LLM.
"""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from flow_sdk.assets.types.claude_sessions import extract_claude_session_from_path
from flow_sdk.fs_store.indexer.functions.claude_sessions import (
    claude_session_start_time,
    discover_claude_session_paths_iter,
)
from flow_sdk.schema.data_spec.usage_report_spec import UsageSessionSpec, UsageSummarySpec
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


_IDLE_GAP = timedelta(minutes=5)


def _active_spans(entries) -> list[tuple[datetime, datetime]]:
    """Merge event timestamps into active spans; a gap over ``_IDLE_GAP`` splits them."""
    times = sorted(t for t in (_parse_iso(getattr(e, "timestamp", None)) for e in entries) if t)
    spans: list[tuple[datetime, datetime]] = []
    for t in times:
        if spans and t - spans[-1][1] <= _IDLE_GAP:
            spans[-1] = (spans[-1][0], t)
        else:
            spans.append((t, t))
    return spans


def _union_ms(spans: list[tuple[datetime, datetime]]) -> int:
    total = 0
    cur = None
    for a, b in sorted(spans):
        if cur and a <= cur[1]:
            cur = (cur[0], max(cur[1], b))
        else:
            if cur:
                total += int((cur[1] - cur[0]).total_seconds() * 1000)
            cur = (a, b)
    if cur:
        total += int((cur[1] - cur[0]).total_seconds() * 1000)
    return total


def analyze_usage(start: datetime, end: datetime) -> UsageSummarySpec:
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

    sessions: list[UsageSessionSpec] = []
    cost_total = 0.0
    in_total = out_total = read_total = write_total = prompts_total = 0

    skill_counter: Counter[str] = Counter()
    agent_counter: Counter[str] = Counter()
    tool_counter: Counter[str] = Counter()
    model_cost: Counter[str] = Counter()
    sample_prompts: list[str] = []
    all_spans: list[tuple[datetime, datetime]] = []

    for path in discover_claude_session_paths_iter():
        # Cheap overlap pre-gate. A session contributes to this window iff some of
        # its activity lands inside it, so we keep any session that *could* overlap
        # and let the per-event filter below decide. Skip only sessions that
        # provably can't: started at/after `end`, or last written before `start`.
        # The mtime check is a stat; run it before parsing so a daily run never
        # reads the sessions that were last written before the window.
        try:
            last_activity = datetime.fromtimestamp(Path(path).stat().st_mtime, tz=timezone.utc)
        except OSError:
            last_activity = None
        if last_activity is not None and last_activity < start:
            continue
        try:
            rec = extract_claude_session_from_path(path, include_content=False)
        except Exception:  # noqa: BLE001 — a single unreadable session must not abort the run
            continue
        started = _session_start(rec)
        if started is not None and started >= end:
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

        # Active time: in-window stretches between events; a longer gap is idle.
        spans = _active_spans(entries_in)
        all_spans.extend(spans)
        duration = sum(int((b - a).total_seconds() * 1000) for a, b in spans)

        cwd = str(getattr(rec, "cwd", "") or "")
        sessions.append(UsageSessionSpec(
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
        ))
        cost_total += cost
        in_total += in_tok
        out_total += out_tok
        read_total += cache_read
        write_total += cache_creation
        prompts_total += prompt_count

    cache_denom = in_total + read_total + write_total
    return UsageSummarySpec(
        period_start=start.isoformat(),
        period_end=end.isoformat(),
        period_kind=period_kind,
        generated_at=datetime.now(timezone.utc).isoformat(),
        total_cost_usd=round(cost_total, 4),
        session_count=len(sessions),
        # Parallel sessions count once: the union of their active spans.
        total_duration_ms=_union_ms(all_spans),
        total_tokens=in_total + out_total + read_total + write_total,
        input_tokens=in_total,
        output_tokens=out_total,
        cache_read_tokens=read_total,
        cache_creation_tokens=write_total,
        cache_hit_rate=round(read_total / cache_denom, 4) if cache_denom else 0.0,
        prompt_count=prompts_total,
        skill_invocations=sum(skill_counter.values()),
        agent_spawns=sum(agent_counter.values()),
        top_skills=[{"name": n, "count": c} for n, c in skill_counter.most_common(_TOP_N)],
        top_agents=[{"type": n, "count": c} for n, c in agent_counter.most_common(_TOP_N)],
        top_tools=[{"name": n, "count": c} for n, c in tool_counter.most_common(_TOP_N)],
        models=[{"model": m, "cost_usd": round(c, 4)} for m, c in model_cost.most_common(_TOP_N)],
        sample_prompts=sample_prompts,
        busiest_session_id=max(sessions, key=lambda r: (r.prompt_count, r.duration_ms)).session_id if sessions else None,
        most_expensive_session_id=max(sessions, key=lambda r: r.cost_usd).session_id if sessions else None,
        sessions=sessions,
    )


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


def yesterday() -> tuple[datetime, datetime]:
    """[yesterday 00:00, today 00:00) in this machine's local time -- the Daily usage summary's window."""
    today = datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
    return today - timedelta(days=1), today


def headline(data: UsageSummarySpec) -> str:
    """The one line a person reads first: the day, cost, sessions, active time, prompts."""
    start = _parse_iso(data.period_start)
    day = start.strftime("%a %b %-d") if start else data.period_start
    if not data.session_count:
        return f"{day}: no agent sessions."
    return (f"{day}: ${data.total_cost_usd:,.2f} across {data.session_count} sessions, "
            f"{_fmt_duration(data.total_duration_ms)} active, {data.prompt_count} prompts.")


def render_markdown(data: UsageSummarySpec) -> str:
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
    lines.append(f"| cache hit rate | {data.cache_hit_rate * 100:.1f}% |")
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
