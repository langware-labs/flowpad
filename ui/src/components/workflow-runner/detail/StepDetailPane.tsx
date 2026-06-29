/**
 * Right-pane content for the selected step. Plain-English explanation +
 * budget card. Expert sections (raw issues, transcript slice,
 * per-run breakdown) land in Phase 6.
 *
 * Pure render: receives the selected step + history, draws the pane.
 * Empty state when nothing selected.
 */

import { cn } from '@src/lib/utils';
import { X } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';

import type { MemoryArtifact, StepHistory, StepViewModel, ViewMode } from '../data/types';
import { BudgetCard } from './BudgetCard';
import { MemoryDiffPane } from './expert/MemoryDiffPane';
import { PerRunBreakdown } from './expert/PerRunBreakdown';
import { RawIssuesList } from './expert/RawIssuesList';
import { TranscriptSlice } from './expert/TranscriptSlice';
import { PlainEnglishWhy } from './PlainEnglishWhy';

interface StepDetailPaneProps {
  step: StepViewModel | null;
  history?: StepHistory;
  memory?: MemoryArtifact;
  viewMode: ViewMode;
  onClose: () => void;
}

function fmtMs(ms?: number): string {
  if (ms === undefined || ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

/**
 * Pull the SLA budget from analyzer issues if present (cycle-4 analyzer
 * emitted `threshold_ms` / `actual_ms` on `sla_violation` issues).
 */
function pickBudget(step: StepViewModel): { actualMs?: number; thresholdMs?: number } {
  for (const iss of step.issues) {
    if (iss.threshold_ms || iss.actual_ms) {
      return { actualMs: iss.actual_ms, thresholdMs: iss.threshold_ms };
    }
  }
  return {};
}

export function StepDetailPane({
  step,
  history,
  memory,
  viewMode,
  onClose,
}: StepDetailPaneProps) {
  const { t } = useLingui();

  if (!step) {
    return (
      <div
        data-testid="step-detail-pane"
        data-state="empty"
        className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground"
      >
        <Trans>Select a step on the left to see why it passed or failed.</Trans>
      </div>
    );
  }

  const { actualMs, thresholdMs } = pickBudget(step);
  const runCount = history?.points.length ?? 0;

  return (
    <div
      data-testid="step-detail-pane"
      data-state="step"
      data-line={step.line}
      className="flex h-full flex-col gap-4 overflow-auto p-4"
    >
      <header className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            <Trans>Step at line {step.line}</Trans>
          </div>
          <h3 className="mt-0.5 truncate text-sm font-medium">{step.step_text}</h3>
        </div>
        <button
          type="button"
          aria-label={t`Close`}
          onClick={onClose}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>

      <section className="grid grid-cols-2 gap-3 text-xs tabular-nums">
        <Stat
          label={t`Status`}
          value={step.status}
          tone={
            step.status === 'error'
              ? 'destructive'
              : step.status === 'skip' || step.status === 'incomplete'
                ? 'muted'
                : 'ok'
          }
        />
        <Stat label={t`Duration`} value={fmtMs(step.duration_ms)} />
        <Stat
          label={t`Cost`}
          value={
            typeof step.cost_usd === 'number'
              ? `$${step.cost_usd.toFixed(step.cost_usd < 0.01 ? 4 : step.cost_usd < 1 ? 3 : 2)}`
              : '—'
          }
        />
        <Stat label={t`History`} value={runCount > 0 ? `${runCount} run${runCount > 1 ? 's' : ''}` : '—'} />
      </section>

      {(actualMs !== undefined || thresholdMs !== undefined) && (
        <BudgetCard actualMs={actualMs} thresholdMs={thresholdMs} />
      )}

      <PlainEnglishWhy step={step} />

      {viewMode === 'expert' && (
        <div className="space-y-2 pt-2">
          <RawIssuesList step={step} viewMode={viewMode} />
          <TranscriptSlice step={step} />
          <PerRunBreakdown history={history} />
          <MemoryDiffPane memory={memory} />
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string | number;
  tone?: 'default' | 'destructive' | 'muted' | 'ok';
}) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'mt-0.5 truncate text-sm font-medium',
          tone === 'destructive' && 'text-destructive',
          tone === 'muted' && 'text-muted-foreground',
          tone === 'ok' && 'text-emerald-600 dark:text-emerald-400',
        )}
      >
        {value}
      </dd>
    </div>
  );
}
