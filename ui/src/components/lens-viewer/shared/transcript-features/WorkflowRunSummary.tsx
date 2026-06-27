/**
 * Header strip for a workflow-run transcript — answers "what am I viewing"
 * (a Workflow run) plus its summary. Reuses the AgentTrace summary vocabulary
 * (StatTile grid + verdictStyle status chip) so it reads consistently with the
 * rest of the agentic-execution UI.
 */
import { Workflow } from 'lucide-react';

import { StatTile } from '@src/components/assets/editor/agent-trace/simple/SimpleSessionReport';
import { verdictStyle } from '@src/components/assets/editor/agent-trace/AgentTraceView';
import { formatDuration, formatNumber } from '@src/components/lens-viewer/shared/format-utils';

/** Map a workflow run status onto the verdict tone vocabulary verdictStyle expects. */
function statusTone(status: string | undefined): string | undefined {
  switch ((status ?? '').toLowerCase()) {
    case 'completed':
    case 'success':
    case 'succeeded':
      return 'ok';
    case 'failed':
    case 'error':
    case 'cancelled':
    case 'canceled':
      return 'bad';
    case 'running':
    case 'partial':
    case 'in_progress':
      return 'mixed';
    default:
      return undefined;
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Source workflow file + owning skill (when bundled) derived from scriptPath. */
function sourceOf(scriptPath: string | undefined): { file: string; skill?: string } | null {
  if (!scriptPath) return null;
  const parts = scriptPath.split('/');
  const file = parts[parts.length - 1] || scriptPath;
  const si = parts.indexOf('skills');
  const skill = si >= 0 && parts[si - 1] === '.claude' && parts[si + 1] ? parts[si + 1] : undefined;
  return { file, skill };
}

interface Props {
  payload: Record<string, unknown>;
  /** Worker label, e.g. "Workflow" → rendered as "Workflow run". */
  label: string;
}

export function WorkflowRunSummary({ payload, label }: Props) {
  const workflowName = (payload.workflowName as string | undefined) || (payload.runId as string | undefined) || '';
  const status = payload.status as string | undefined;
  const modelProvider = payload.model_provider as string | undefined;
  const source = sourceOf(payload.scriptPath as string | undefined);

  return (
    <div className="shrink-0 border-b border-border bg-muted/30 p-3">
      <div className="mb-2 flex min-w-0 items-center gap-2 text-sm">
        <Workflow className="h-4 w-4 shrink-0 text-indigo-500" />
        <span className="shrink-0 text-muted-foreground">{label} run</span>
        {workflowName && <span className="min-w-0 truncate font-semibold text-foreground">{workflowName}</span>}
        {status && (
          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${verdictStyle(statusTone(status))}`}>
            {status}
          </span>
        )}
        {modelProvider && <span className="ml-auto shrink-0 truncate text-[11px] text-muted-foreground">{modelProvider}</span>}
      </div>
      {source && (
        <div className="mb-2 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground" data-testid="wf-run-source">
          <span className="shrink-0">Source:</span>
          <span className="min-w-0 truncate font-medium text-foreground">{source.file}</span>
          {source.skill && <span className="shrink-0">· skill: {source.skill}</span>}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile label="Agents" value={formatNumber(num(payload.agentCount))} />
        <StatTile label="Tokens" value={formatNumber(num(payload.totalTokens))} />
        <StatTile label="Tool calls" value={formatNumber(num(payload.totalToolCalls))} />
        <StatTile label="Duration" value={formatDuration(num(payload.durationMs))} />
      </div>
    </div>
  );
}
