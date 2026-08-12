import { t } from '@lingui/core/macro';
import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { AlertTriangle, PlayCircle, Plug, RefreshCw, Wand2, type LucideIcon } from 'lucide-react';
import { AgenticProcess, Project, TypeId, dataContext, type TerminalRuntimeError } from '@sdk';
import { notify } from '@src/notifications';
import { Button } from '@src/components/ui/button';
import { useContext as useDataContext } from '@src/hooks/useContext';

/**
 * Per-kind copy + primary action for the runtime-error banner. Each entry
 * describes what the user sees and what the action does when clicked.
 *
 * Severity-wise these are all "soft" failures from
 * ``ProcessLoadError``: the entity exists, only the runtime needs help.
 * The route loader has already populated
 * ``dataContext.terminalRuntimeError`` and kept the user on the URL they
 * requested; this banner is what makes the recovery surface visible.
 */
interface KindConfig {
  icon: LucideIcon;
  /** Compact one-line headline shown on the banner. */
  title: string;
  /** Subtext under the title (optional). */
  detail?: string;
  /** Action button label + handler factory. */
  actionLabel: string;
  actionIcon: LucideIcon;
  /** Async — returns true on success so the banner can self-dismiss. */
  action: (processId: string) => Promise<boolean>;
}

async function loadProcessById(processId: string): Promise<AgenticProcess | null> {
  const cached = AgenticProcess.getByIdFromCache<AgenticProcess>(processId);
  if (cached) return cached;
  try {
    return (await AgenticProcess.getById<AgenticProcess>(processId)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Retry ``process.start({visible:true})``. Used by both
 * ``runtime_terminated`` (the process stopped) and ``pty_attach_failed``
 * (PTY died) — the same backend `open` action is idempotent and handles
 * both cases, so the recovery code path is shared.
 */
async function retryStart(processId: string): Promise<boolean> {
  const process = await loadProcessById(processId);
  if (!process) {
    notify.error({ title: t`Couldn’t resolve this process.`, id: `terminal-recover:${processId}` });
    return false;
  }
  try {
    await process.start({ visible: true });
    notify.success({ title: t`Reconnected.`, id: `terminal-recover:${processId}` });
    dataContext.setTerminalRuntimeError(null);
    return true;
  } catch (err) {
    notify.error({
      title: err instanceof Error ? err.message : 'Reconnect failed.',
      id: `terminal-recover:${processId}`,
    });
    return false;
  }
}

/**
 * Explicit user retry of a failed-to-start process. ``retry: true`` is what
 * clears the server-side ``start_failure`` latch — a plain ``start()`` would
 * be refused (that refusal is the loop-breaker; only a user click re-arms).
 * Exported: the shell-less panel dead-end (`TerminalPanelErrorState`) shares
 * this exact recovery, so the retry semantics live in one place.
 */
export async function retryFailedStart(processId: string): Promise<boolean> {
  const process = await loadProcessById(processId);
  if (!process) {
    notify.error({ title: t`Couldn’t resolve this process.`, id: `terminal-recover:${processId}` });
    return false;
  }
  try {
    await process.start({ visible: true, retry: true });
    notify.success({ title: t`Relaunched.`, id: `terminal-recover:${processId}` });
    dataContext.setTerminalRuntimeError(null);
    return true;
  } catch (err) {
    notify.error({ title: err instanceof Error ? err.message : 'Retry failed.', id: `terminal-recover:${processId}` });
    return false;
  }
}

async function recoverProject(processId: string): Promise<boolean> {
  const process = await loadProcessById(processId);
  if (!process) {
    notify.error({ title: t`Couldn’t resolve this process.`, id: `terminal-recover:${processId}` });
    return false;
  }
  try {
    const recovered = await process.recoverProject();
    if (!recovered) {
      notify.error({ title: t`Project not recoverable from this workdir.`, id: `terminal-recover:${processId}` });
      return false;
    }
    await dataContext.setContextEntityTypeId(
      // ContextEntitiesEnum.CurrentProjectTypeId mirrored as a literal so
      // we don't drag the whole enum import in here.
      'CurrentProjectTypeId' as never,
      new TypeId(Project.type, recovered.id),
    );
    notify.success({ title: t`Project recovered.`, id: `terminal-recover:${processId}` });
    dataContext.setTerminalRuntimeError(null);
    return true;
  } catch (err) {
    notify.error({
      title: err instanceof Error ? err.message : 'Project recovery failed.',
      id: `terminal-recover:${processId}`,
    });
    return false;
  }
}

async function retryNetwork(_processId: string): Promise<boolean> {
  // The simplest reliable retry is a full reload. Anything finer-grained
  // would need to know which fetch failed; ``network_error`` says only
  // "the entity fetch threw". A reload re-runs the route loader.
  window.location.reload();
  return true;
}

const KIND_CONFIG: Record<TerminalRuntimeError['kind'], KindConfig> = {
  runtime_terminated: {
    icon: AlertTriangle,
    title: t`This process has stopped.`,
    detail: 'Click Restart to spawn a fresh PTY.',
    actionLabel: 'Restart',
    actionIcon: PlayCircle,
    action: retryStart,
  },
  pty_attach_failed: {
    icon: Plug,
    title: t`PTY disconnected.`,
    detail: 'The backend may have restarted. Click to reattach.',
    actionLabel: 'Reconnect',
    actionIcon: Plug,
    action: retryStart,
  },
  shell_entity_missing: {
    icon: AlertTriangle,
    title: t`Shell record is missing for this process.`,
    detail: 'A fresh shell needs to be allocated. (Backend action coming — for now Restart will retry.)',
    actionLabel: 'Restart',
    actionIcon: PlayCircle,
    action: retryStart,
  },
  project_missing: {
    icon: Wand2,
    title: t`This process points to a deleted project.`,
    detail: 'Recover it from the workdir, or pick a new project via the project chip.',
    actionLabel: 'Recover project',
    actionIcon: Wand2,
    action: recoverProject,
  },
  network_error: {
    icon: RefreshCw,
    title: t`Couldn’t reach the backend.`,
    detail: 'The fetch failed. Retry once the backend is up.',
    actionLabel: 'Retry',
    actionIcon: RefreshCw,
    action: retryNetwork,
  },
  project_mismatch: {
    icon: AlertTriangle,
    title: t`This session belongs to a different project.`,
    detail:
      'The transcript on disk was started under another project — the binding here is frozen to avoid silent drift. Reload to re-resolve, or open the session under its real project.',
    actionLabel: 'Reload',
    actionIcon: RefreshCw,
    action: retryNetwork,
  },
  failed_to_start: {
    icon: AlertTriangle,
    title: t`Failed to start.`,
    detail: 'The worker exited immediately after launch, so auto-relaunch is paused. Retry to launch it again.',
    actionLabel: 'Retry',
    actionIcon: RefreshCw,
    action: retryFailedStart,
  },
};

/**
 * Banner shown above the xterm canvas when the route loader recorded a
 * soft runtime failure. The route already kept the user on their
 * requested URL — this is the recovery affordance.
 *
 * Renders nothing when ``dataContext.terminalRuntimeError`` is null. When
 * set, picks per-kind copy + action from KIND_CONFIG and lets the user
 * fire the recovery in one click.
 */
export function TerminalRuntimeErrorBanner() {
  const { terminalRuntimeError } = useDataContext();
  const [busy, setBusy] = useState(false);
  const { t } = useLingui();

  if (!terminalRuntimeError) return null;
  const cfg = KIND_CONFIG[terminalRuntimeError.kind];
  if (!cfg) return null;

  // failed_to_start carries a concrete server-recorded reason on the entity
  // (`start_failure`, e.g. "Worker exited 0.9s after launch (exit code 1)").
  // Prefer it over the generic copy when the process is in cache.
  const latchedReason =
    terminalRuntimeError.kind === 'failed_to_start'
      ? AgenticProcess.getByIdFromCache<AgenticProcess>(terminalRuntimeError.processId)?.start_failure
      : null;
  const detail = latchedReason ? `${latchedReason} Auto-relaunch is paused — Retry to launch again.` : cfg.detail;

  const Icon = cfg.icon;
  const ActionIcon = cfg.actionIcon;

  return (
    <div
      className="flex items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-[12px] text-amber-900 dark:text-amber-200"
      data-testid="terminal-runtime-error-banner"
      data-error-kind={terminalRuntimeError.kind}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{cfg.title}</div>
        {detail && <div className="text-[11px] opacity-80">{detail}</div>}
      </div>
      <Button
        type="button"
        size="sm"
        variant="default"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await cfg.action(terminalRuntimeError.processId);
          } finally {
            setBusy(false);
          }
        }}
        data-testid="terminal-runtime-error-banner-action"
        className="shrink-0"
      >
        <ActionIcon className="h-3.5 w-3.5" />
        {busy ? t`Working…` : cfg.actionLabel}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => dataContext.setTerminalRuntimeError(null)}
        data-testid="terminal-runtime-error-banner-dismiss"
        className="shrink-0 opacity-70 hover:opacity-100"
        title={t`Dismiss banner (the runtime error stays — this just hides the affordance)`}
      >
        <Trans>Dismiss</Trans>
      </Button>
    </div>
  );
}
