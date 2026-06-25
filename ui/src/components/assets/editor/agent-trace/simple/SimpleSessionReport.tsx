import { useMemo } from 'react';
import type { AgentTrace } from '@sdk';

import { formatDuration } from '@src/components/lens-viewer/shared/format-utils';
import { cn } from '@src/lib/utils';

import { verdictStyle } from '../AgentTraceView';
import type { AgentTraceDoc } from '../trace-types';
import {
  flattenIssues,
  friendlyKind,
  friendlySeverity,
  friendlyVerdict,
  pluralize,
  skillsInvolved,
  type ReportIssue,
  type Tone,
} from './report-language';

interface SimpleSessionReportProps {
  trace: AgentTrace;
  /** The parsed trace.json; null until it resolves (or if absent). */
  doc: AgentTraceDoc | null;
}

/** Soft chip tint per tone — matches the verdict palette. */
function toneChip(tone: Tone): string {
  switch (tone) {
    case 'ok':
      return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';
    case 'mixed':
      return 'bg-amber-500/10 text-amber-600 dark:text-amber-400';
    case 'bad':
      return 'bg-red-500/10 text-red-600 dark:text-red-400';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col rounded border border-border bg-muted/40 px-3 py-2">
      <span className="text-lg font-semibold text-foreground">{value}</span>
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h3>
  );
}

function IssueRow({ issue }: { issue: ReportIssue }) {
  const sev = friendlySeverity(issue.severity);
  return (
    <div className="rounded border border-border/60 bg-muted/30 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium', toneChip(sev.tone))}>
          {sev.label}
        </span>
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
          {friendlyKind(issue.kind)}
        </span>
        {issue.count > 1 && (
          <span className="text-[11px] font-medium text-muted-foreground">×{issue.count}</span>
        )}
      </div>
      <p className="mt-1 text-sm text-foreground">{issue.title}</p>
      {issue.detail && <p className="mt-0.5 text-xs text-muted-foreground">{issue.detail}</p>}
    </div>
  );
}

/**
 * The plain-language "what happened in your session" report — the default view
 * of an AgentTrace asset for non-technical users. Read-only: a friendly verdict,
 * a few simple stats, what the assistant worked on, a plain list of things to
 * look at, and which helpers (skills) it used. The advanced timeline lives
 * behind the Advanced-mode toggle in {@link AgentTraceAssetEditor}.
 */
export function SimpleSessionReport({ trace, doc }: SimpleSessionReportProps) {
  // Prefer the cheap entity-row fields so stats paint before the JSON loads;
  // fall back to the doc summary once present.
  const summary = doc?.summary;
  const verdict = trace.verdict ?? summary?.verdict ?? null;
  const reason = trace.verdict_reason ?? summary?.verdict_reason ?? null;
  const durationMs = trace.duration_ms ?? summary?.duration_ms ?? null;
  const costUsd = trace.cost_usd ?? summary?.cost_usd ?? null;
  const stepCount = summary?.tool_call_count ?? null;
  const problemCount =
    (trace.issue_count ?? summary?.issue_count ?? 0) +
    (trace.divergence_count ?? summary?.divergence_count ?? 0);

  const v = friendlyVerdict(verdict, reason);
  const goals = doc?.annotations?.goals ?? [];
  const issues = useMemo(() => flattenIssues(doc), [doc]);
  const skills = useMemo(() => skillsInvolved(doc), [doc]);
  const hasVerdict = !!verdict && verdict !== 'unrated';

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="simple-session-report">
      <div className="mx-auto flex max-w-2xl flex-col gap-5 px-4 py-4">
        {/* Verdict hero */}
        <div className={cn('rounded-lg px-4 py-3', verdictStyle(verdict))}>
          <div className="flex items-baseline gap-2">
            <span className="text-xl leading-none">{v.emoji}</span>
            <span className="text-base font-semibold">{v.headline}</span>
          </div>
          {v.reason && <p className="mt-1.5 text-sm opacity-90">{v.reason}</p>}
        </div>

        {!hasVerdict && (
          <p className="text-sm text-muted-foreground">
            This session hasn't been reviewed yet, so there's nothing to report.
          </p>
        )}

        {/* Stats */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatTile label="Time spent" value={durationMs != null ? formatDuration(durationMs) : '—'} />
          <StatTile label="Cost" value={costUsd != null ? `$${costUsd.toFixed(2)}` : '—'} />
          <StatTile label="Steps taken" value={stepCount != null ? String(stepCount) : '—'} />
          <StatTile label="Problems found" value={String(problemCount)} />
        </div>

        {/* What it worked on */}
        {goals.length > 0 && (
          <div>
            <SectionHeading>What it worked on</SectionHeading>
            <ul className="list-disc space-y-0.5 pl-5 text-sm text-foreground">
              {goals.map((g, i) => (
                <li key={i}>{g.label}</li>
              ))}
            </ul>
          </div>
        )}

        {/* What to look at */}
        <div>
          <SectionHeading>What to look at</SectionHeading>
          {!doc ? (
            <p className="text-sm text-muted-foreground">Loading details…</p>
          ) : issues.length === 0 ? (
            <p className="rounded border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
              🎉 No problems found — nothing needs your attention.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {issues.map((issue, i) => (
                <IssueRow key={i} issue={issue} />
              ))}
            </div>
          )}
        </div>

        {/* Helpers used */}
        {skills.length > 0 && (
          <div>
            <SectionHeading>Helpers used</SectionHeading>
            <ul className="flex flex-col gap-1 text-sm">
              {skills.map((s) => (
                <li
                  key={s.name}
                  className="flex items-center justify-between rounded border border-border/50 px-3 py-1.5"
                >
                  <span className="truncate text-foreground" title={s.name}>
                    {s.name}
                  </span>
                  <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                    {s.issueCount === 0 ? 'all good' : pluralize(s.issueCount, 'problem')}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
