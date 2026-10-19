import React, { useMemo, useState } from 'react';
import type { AgentTrace, AgenticProcess } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  GitCompare,
  GraduationCap,
  Loader2,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { formatTimeAgo } from '@src/utils/format-time-ago';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import {
  AnalysisToolbarButtons,
  AnalysisSidePanel,
  useAnalysisControls,
} from '@src/components/lens-viewer/shared/transcript-features/AnalysisControls';
import { createdMs } from '@src/components/lens-viewer/shared/transcript-features/analysis-state';
import { projectedRunSavingsUsd } from './analysis-improvements';
import { useAnalysisImprovements } from './useAnalysisImprovements';
import { ImprovementResultsModal } from './ImprovementResultsModal';

interface AnalysisPanelProps {
  /** The agentic process whose session is analyzed. */
  process: AgenticProcess | null;
}

const VERDICT_STYLE: Record<string, { color: string; icon: LucideIcon }> = {
  ok: { color: 'text-emerald-600 dark:text-emerald-400', icon: CheckCircle2 },
  bad: { color: 'text-destructive', icon: AlertTriangle },
  mixed: { color: 'text-amber-600 dark:text-amber-400', icon: AlertTriangle },
};

function VerdictBadge({ verdict }: { verdict?: string }) {
  const key = (verdict ?? '').toLowerCase();
  const { color, icon: Icon } = VERDICT_STYLE[key] ?? VERDICT_STYLE.mixed;
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] ${color}`}>
      <Icon className="h-3 w-3" /> {key || 'mixed'}
    </span>
  );
}

function IssuesBadge({ count }: { count: number }) {
  if (count === 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="h-3 w-3" /> <Trans>clean</Trans>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">
      <AlertTriangle className="h-3 w-3" /> {count} issue{count === 1 ? '' : 's'}
    </span>
  );
}

const usd = (n: number) => (n >= 10 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);

/**
 * Improvement detail for one analysis — a portal MODAL (not an in-row expand, so
 * it never resizes the terminal side-window and can't trip the terminal's
 * ResizeObserver). Loads the trace doc once (only while open), shows the
 * projected value + the per-skill Improve → diff → version controls.
 */
function AnalysisImprovementModal({ trace, onClose }: { trace: AgentTrace; onClose: () => void }) {
  const { t } = useLingui();
  const { skills, improve, refreshDirty, doc } = useAnalysisImprovements(trace);
  const { navigation } = useDockNavigation();
  const [diff, setDiff] = useState<{ skillName: string; skillFile: NonNullable<typeof skills[number]['skillFile']> } | null>(null);
  const perRun = projectedRunSavingsUsd(doc);
  const issues = (trace.issue_count ?? 0) + (trace.divergence_count ?? 0);

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="flex max-h-[80vh] w-[460px] max-w-[92vw] flex-col gap-3" data-testid="analysis-improve-modal">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2 text-sm font-medium">
            <Sparkles className="h-4 w-4" /> <Trans>Improve from this analysis</Trans>
          </DialogTitle>
        </DialogHeader>

        <div className="shrink-0 rounded-md border p-2">
          {perRun > 0 ? (
            <div className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">
              ~{usd(perRun)}<Trans>/run reclaimable </Trans><span className="text-[10px] font-normal text-muted-foreground"><Trans>projected</Trans></span>
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              {issues > 0 ? <Trans>Fixing these tightens the skill for every future run.</Trans> : <Trans>Clean run — nothing to reclaim.</Trans>}
            </div>
          )}
          <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
            <VerdictBadge verdict={trace.verdict} />
            <span>{issues} issue{issues === 1 ? '' : 's'}</span>
            {trace.verdict_reason && <span className="truncate">· {trace.verdict_reason}</span>}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {skills.length === 0 ? (
            <p className="px-1 py-2 text-[11px] text-muted-foreground"><Trans>No skill-attributed findings to improve.</Trans></p>
          ) : (
            <div className="flex flex-col gap-1">
              {skills.map((s) => (
                <div key={s.skillName} className="flex items-center gap-2 rounded px-1.5 py-1 text-[11px] hover:bg-muted/40">
                  <GraduationCap className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">
                    {s.skillName} · <span className="text-muted-foreground">{s.findings.length} finding{s.findings.length === 1 ? '' : 's'}</span>
                  </span>
                  {s.status === 'running' ? (
                    <span className="flex items-center gap-1 text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> <Trans>Improving…</Trans></span>
                  ) : s.status === 'done' && s.skillFile ? (
                    <button
                      type="button"
                      onClick={() => setDiff({ skillName: s.skillName, skillFile: s.skillFile! })}
                      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-primary hover:bg-muted"
                      data-testid="improvement-results-open"
                    >
                      <GitCompare className="h-3.5 w-3.5" /> <Trans>Review changes</Trans>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void improve(s.skillName)}
                      disabled={!s.canImprove}
                      title={!s.skill ? t`Skill not installed` : undefined}
                      className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted disabled:opacity-50"
                      data-testid="improvement-run"
                    >
                      <GraduationCap className="h-3.5 w-3.5" /> <Trans>Improve</Trans>
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => navigation.openDock(trace.editorDockPointer)}
          className="flex shrink-0 items-center gap-1 self-start rounded px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ExternalLink className="h-3.5 w-3.5" /> <Trans>Open full report</Trans>
        </button>
      </DialogContent>

      {diff && (
        <ImprovementResultsModal
          skillFile={diff.skillFile}
          skillName={diff.skillName}
          open
          onClose={() => setDiff(null)}
          onCommitted={refreshDirty}
          valueNote={perRun > 0 ? `~${usd(perRun)}/run reclaimable (projected)` : undefined}
        />
      )}
    </Dialog>
  );
}

/**
 * Terminal side-window: a FLAT list of this session's analyses (AgentTrace). No
 * in-row expand (that perturbed the terminal layout and tripped its
 * ResizeObserver). Each row is a static summary; the projected value + Improve →
 * diff → version live in a portal modal opened by the row's Improve button, and
 * the external-link opens the full report. Run/Rerun reuse the transcript controls.
 */
export const AnalysisPanel: React.FC<AnalysisPanelProps> = ({ process }) => {
  const { t } = useLingui();
  const sessionId = process?.session_id ?? null;
  const controls = useAnalysisControls(sessionId, null);
  const { navigation } = useDockNavigation();
  const [modalTrace, setModalTrace] = useState<AgentTrace | null>(null);

  const sorted = useMemo(
    () => [...controls.traces].sort((a, b) => (createdMs(b) || -Infinity) - (createdMs(a) || -Infinity)),
    [controls.traces],
  );

  const emptyMessage = !sessionId
    ? t`No session to analyze yet.`
    : t`No analyses yet — Run analysis to investigate this session.`;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <Activity className="h-3.5 w-3.5" /> <Trans>Analysis</Trans>
        </span>
        <AnalysisToolbarButtons controls={controls} />
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {sorted.length === 0 ? (
          <p className="mt-4 px-2 text-center text-xs text-muted-foreground">{emptyMessage}</p>
        ) : (
          <div className="flex flex-col gap-1">
            {sorted.map((t) => {
              const issueTotal = (t.issue_count ?? 0) + (t.divergence_count ?? 0);
              return (
                <div
                  key={t.id}
                  className="flex flex-col gap-1 rounded-md border border-transparent px-2 py-1.5 hover:border-border"
                  data-testid="analysis-list-row"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <IssuesBadge count={issueTotal} />
                      <VerdictBadge verdict={t.verdict} />
                    </div>
                    <span className="text-[10px] text-muted-foreground">
                      {formatTimeAgo(t.created_date instanceof Date ? t.created_date.toISOString() : t.created_date)}
                    </span>
                  </div>
                  {t.verdict_reason && <p className="truncate text-xs text-foreground/80">{t.verdict_reason}</p>}
                  <div className="flex items-center gap-1">
                    {issueTotal > 0 && (
                      <button
                        type="button"
                        onClick={() => setModalTrace(t)}
                        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-primary hover:bg-muted"
                        data-testid="analysis-improve-open"
                      >
                        <Sparkles className="h-3.5 w-3.5" /> <Trans>Improve</Trans>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => navigation.openDock(t.editorDockPointer)}
                      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                      data-testid="analysis-open-timeline"
                    >
                      <ExternalLink className="h-3.5 w-3.5" /> <Trans>Report</Trans>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {modalTrace && <AnalysisImprovementModal trace={modalTrace} onClose={() => setModalTrace(null)} />}

      {/* Reused execution drawer — the Run/Rerun button pops this open. */}
      <AnalysisSidePanel controls={controls} />
    </div>
  );
};
