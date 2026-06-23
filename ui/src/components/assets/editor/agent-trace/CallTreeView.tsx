import { useMemo, useState } from 'react';
import {
  Archive,
  Bot,
  ChevronRight,
  FlaskConical,
  Layers,
  Sparkles,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@src/lib/utils';
import { useSkillsByName } from '@src/hooks/useSkillsByName';
import { useIsAdvanced } from '@src/contexts/view-mode-context';
import { fmtDuration } from './format';
import type { AgentTraceDoc, CallFrame } from './trace-types';

type Metric = 'cost' | 'time' | 'issues';

const METRICS: { key: Metric; label: string }[] = [
  { key: 'cost', label: 'Cost' },
  { key: 'time', label: 'Time' },
  { key: 'issues', label: 'Issues' },
];

const KIND_ICON: Record<CallFrame['kind'], LucideIcon> = {
  session: Layers,
  skill: Sparkles,
  subagent: Bot,
  tool: Wrench,
  compaction: Archive,
};

function metricOf(f: CallFrame, m: Metric): number {
  if (m === 'cost') return f.total_cost_usd;
  if (m === 'time') return f.total_duration_ms;
  return f.issue_count;
}

function policyChipClass(policy: string): string {
  switch (policy) {
    case 'isolate':
      return 'bg-violet-500/15 text-violet-600 dark:text-violet-400';
    case 'compact':
      return 'bg-sky-500/15 text-sky-600 dark:text-sky-400';
    case 'retrieve':
      return 'bg-teal-500/15 text-teal-600 dark:text-teal-400';
    case 'transfer':
      return 'bg-orange-500/15 text-orange-600 dark:text-orange-400';
    case 'checkpoint':
      return 'bg-amber-500/15 text-amber-600 dark:text-amber-400';
    default: // preserve
      return 'bg-muted text-muted-foreground';
  }
}

function severityRowClass(sev: string): string {
  return sev === 'attention'
    ? 'text-red-600 dark:text-red-400'
    : sev === 'notable'
      ? 'text-amber-600 dark:text-amber-400'
      : '';
}

interface CallTreeViewProps {
  doc: AgentTraceDoc;
  selectedFrameId: string | null;
  onSelectFrame: (frame: CallFrame) => void;
  /** Launch a skillit analysis for the given skill name. Omitted → no Evaluate
   *  button (e.g. the read-only lens variant). */
  onEvaluateSkill?: (skillName: string) => void;
}

/**
 * "Transcript call stack" — the run decomposed into nested frames
 * (session → skill → subagent → tool/compaction), each with rolled-up time,
 * cost, and issues. Expandable rows, metric-driven bars + sort, click to seek.
 */
export function CallTreeView({ doc, selectedFrameId, onSelectFrame, onEvaluateSkill }: CallTreeViewProps) {
  const [metric, setMetric] = useState<Metric>('cost');
  const { isEvalByName } = useSkillsByName();
  // The under-eval marker is an Advanced/Dev affordance; Standard mode hides it.
  const advanced = useIsAdvanced();
  const root = doc.call_tree;

  const rootMetric = useMemo(() => (root ? Math.max(metricOf(root, metric), 1e-9) : 1), [root, metric]);

  if (!root) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        This trace predates the call-stack view. Re-run the analysis (Refresh) to generate it.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="call-tree-view">
      <div className="flex flex-shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <span className="text-xs text-muted-foreground">Drill by</span>
        <div className="inline-flex rounded-md bg-muted p-0.5">
          {METRICS.map((m) => (
            <button
              key={m.key}
              onClick={() => setMetric(m.key)}
              className={cn(
                'rounded px-2 py-0.5 text-xs font-medium transition-colors',
                metric === m.key
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              data-testid={`call-tree-metric-${m.key}`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1 font-mono text-xs">
        <FrameRow
          frame={root}
          depth={0}
          metric={metric}
          rootMetric={rootMetric}
          selectedFrameId={selectedFrameId}
          onSelectFrame={onSelectFrame}
          isEvalByName={isEvalByName}
          onEvaluateSkill={onEvaluateSkill}
          advanced={advanced}
          defaultOpen
        />
      </div>
    </div>
  );
}

interface FrameRowProps {
  frame: CallFrame;
  depth: number;
  metric: Metric;
  rootMetric: number;
  selectedFrameId: string | null;
  onSelectFrame: (frame: CallFrame) => void;
  isEvalByName: (name: string) => boolean;
  onEvaluateSkill?: (skillName: string) => void;
  /** Advanced/Dev view mode — gates the under-eval marker. */
  advanced: boolean;
  defaultOpen?: boolean;
}

function FrameRow({
  frame,
  depth,
  metric,
  rootMetric,
  selectedFrameId,
  onSelectFrame,
  isEvalByName,
  onEvaluateSkill,
  advanced,
  defaultOpen,
}: FrameRowProps) {
  const [open, setOpen] = useState(defaultOpen ?? depth < 2);
  const hasChildren = frame.children.length > 0;
  const Icon = KIND_ICON[frame.kind] ?? Wrench;
  const barFrac = Math.min(1, metricOf(frame, metric) / rootMetric);
  const selected = selectedFrameId === frame.id;
  const isSkill = frame.kind === 'skill';
  const underEval = advanced && isSkill && isEvalByName(frame.callable);

  // Inefficiency flag: many issues per dollar/minute under this frame.
  const inefficient =
    (frame.issues_per_usd != null && frame.issues_per_usd >= 1) ||
    (frame.issues_per_min != null && frame.issues_per_min >= 2);

  const sortedChildren = useMemo(
    () => [...frame.children].sort((a, b) => metricOf(b, metric) - metricOf(a, metric)),
    [frame.children, metric],
  );

  return (
    <div>
      <div
        className={cn(
          'flex cursor-pointer items-center gap-1.5 rounded px-2 py-0.5 hover:bg-muted/60',
          selected && 'bg-accent',
        )}
        style={{ paddingLeft: depth * 14 + 8 }}
        onClick={() => onSelectFrame(frame)}
        data-testid={`call-frame-${frame.kind}`}
      >
        <button
          className="flex h-4 w-4 flex-shrink-0 items-center justify-center"
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) setOpen((v) => !v);
          }}
        >
          {hasChildren && (
            <ChevronRight
              className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', open && 'rotate-90')}
            />
          )}
        </button>
        <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
        <span className={cn('truncate', severityRowClass(frame.worst_severity))}>{frame.callable}</span>
        {underEval && (
          <span
            className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded bg-blue-500/15 text-blue-600 ring-1 ring-blue-500/20 dark:text-blue-400"
            title="Under eval"
            aria-label="Under eval"
            data-testid="call-frame-under-eval"
          >
            <FlaskConical className="h-2.5 w-2.5" />
          </span>
        )}
        {isSkill && onEvaluateSkill && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onEvaluateSkill(frame.callable);
            }}
            title={`Evaluate "${frame.callable}"`}
            data-testid="call-frame-evaluate-skill"
            className="flex-shrink-0 rounded px-1 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            Eval
          </button>
        )}
        {frame.kind === 'tool' && frame.tool_call_count > 1 && (
          <span className="flex-shrink-0 text-[10px] text-muted-foreground">×{frame.tool_call_count}</span>
        )}
        {frame.mcp && <span className="flex-shrink-0 text-[9px] text-teal-500">mcp</span>}
        <span
          className={cn(
            'flex-shrink-0 rounded px-1 text-[9px] uppercase tracking-wide',
            policyChipClass(frame.context_policy),
          )}
        >
          {frame.context_policy}
        </span>

        {/* Proportional metric bar */}
        <div className="relative ml-1 h-2 min-w-[40px] flex-1">
          <div className="absolute inset-y-0 left-0 rounded-sm bg-border" style={{ width: '100%' }} />
          <div
            className={cn(
              'absolute inset-y-0 left-0 rounded-sm',
              frame.worst_severity === 'attention' ? 'bg-red-500/60' : 'bg-primary/50',
            )}
            style={{ width: `${barFrac * 100}%` }}
          />
        </div>

        <span className="w-12 flex-shrink-0 text-right text-muted-foreground">
          {fmtDuration(frame.total_duration_ms)}
        </span>
        <span className="w-16 flex-shrink-0 text-right text-muted-foreground">
          {frame.total_cost_usd > 0 ? `$${frame.total_cost_usd.toFixed(2)}` : '—'}
        </span>
        <span
          className={cn(
            'w-10 flex-shrink-0 text-right',
            frame.issue_count > 0 ? 'text-red-500' : 'text-muted-foreground',
            inefficient && 'font-bold',
          )}
          title={
            frame.issues_per_usd != null || frame.issues_per_min != null
              ? `${frame.issues_per_usd ?? 0}/＄ · ${frame.issues_per_min ?? 0}/min`
              : undefined
          }
        >
          {frame.issue_count > 0 ? `⚠${frame.issue_count}` : '·'}
        </span>
      </div>

      {open &&
        sortedChildren.map((child) => (
          <FrameRow
            key={child.id}
            frame={child}
            depth={depth + 1}
            metric={metric}
            rootMetric={rootMetric}
            selectedFrameId={selectedFrameId}
            onSelectFrame={onSelectFrame}
            isEvalByName={isEvalByName}
            onEvaluateSkill={onEvaluateSkill}
            advanced={advanced}
          />
        ))}
    </div>
  );
}
