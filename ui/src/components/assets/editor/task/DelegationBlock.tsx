import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import apiClient from '@sdk/client';
import type { Task } from '@sdk';
import { statusLabel } from '@src/components/task-bar/constants';
import { isDelegatedTask } from '@src/components/task-bar/task-utils';
import { notify } from '@src/notifications';
import { FolderInput, Workflow } from 'lucide-react';
import { useState } from 'react';

/** `agent:<id>` / `subagent:<name>` / `user:local` → what a person reads. */
function whoIs(ref?: string | null): string {
  const [kind, ...rest] = String(ref ?? '').split(':');
  const value = rest.join(':');
  if (kind === 'subagent') return value;
  if (kind === 'user') return t`You`;
  if (kind === 'agent') return t`Agent ${value.slice(0, 8)}`;
  return ref || '—';
}

/**
 * A delegated task's ledger facts: who asked for it, who does it, its run, and what came of it —
 * written by the task ledger, shown here read-only. While it lives only on this machine
 * (`placement: instance`) a person may keep it in the project, where it becomes a `task.md`
 * folder asset in git.
 */
export function DelegationBlock({ task }: { task: Task }) {
  const [keeping, setKeeping] = useState(false);
  if (!isDelegatedTask(task)) return null;

  const keep = async () => {
    setKeeping(true);
    try {
      await apiClient.post(`/api/v1/tasks/${task.id}/keep`, {});
      notify.success({ title: t`Kept in the project`, message: t`The task is now a folder in the project.` });
    } catch (e) {
      notify.error({ title: t`Could not keep the task`, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setKeeping(false);
    }
  };

  const rows: [string, string][] = [
    [t`Asked by`, whoIs(task.creator)],
    [t`Owner`, whoIs(task.owner)],
    [t`Status`, statusLabel(task.status ?? undefined)],
    ...(task.process_id ? ([[t`Run`, String(task.process_id).replace(/^agentic_process-/, '').slice(0, 8)]] as [string, string][]) : []),
    ...(task.cost_usd ? ([[t`Cost`, `$${Number(task.cost_usd).toFixed(2)}`]] as [string, string][]) : []),
  ];

  return (
    <div className="flex flex-col gap-2 border-b px-6 py-3" data-testid="task-delegation">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          <Workflow className="h-3.5 w-3.5" />
          <Trans>Delegated</Trans>
        </div>
        {task.placement === 'instance' && (
          <button
            type="button"
            onClick={() => void keep()}
            disabled={keeping}
            className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            title={t`Save this task into the project as a folder, where git tracks it`}
            data-testid="task-keep-in-project"
          >
            <FolderInput className="h-3.5 w-3.5" />
            <Trans>Keep in project</Trans>
          </button>
        )}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="truncate">{value}</dd>
          </div>
        ))}
      </dl>
      {task.result && (
        <p className="whitespace-pre-wrap rounded-md bg-muted/50 px-3 py-2 text-sm" data-testid="task-result">
          {task.result}
        </p>
      )}
    </div>
  );
}
