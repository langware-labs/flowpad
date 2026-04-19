/**
 * AgenticProcess pointer loading for the /dock/shell route.
 *
 * Resolves an agentic_process dock pointer to its live Shell, starts the
 * process (idempotent), attaches the PTY, and writes the resulting identity
 * into dataContext. Failures redirect back to /dock/shell with the offending
 * ids in `skip_*` query params so the default-shell resolver won't loop.
 */

import {
  AgenticProcess,
  ContextEntitiesEnum,
  dataContext,
  Project,
  systemTools,
  TypeId,
} from '@sdk';
import { toast } from '@src/hooks/use-toast';
import { redirect } from 'react-router';
import {
  appendRecoverySkip,
  buildShellRecoveryUrl,
  type ShellRecoverySkips,
} from './shell-recovery';

export function describeProcessStartError(error: unknown): { title: string; description: string } {
  const rawMessage = error instanceof Error ? error.message : String(error ?? '').trim();
  if (/PTY .* not found/i.test(rawMessage)) {
    return {
      title: 'Terminal reattach failed',
      description: rawMessage,
    };
  }
  if (/compute[_ -]?node/i.test(rawMessage) && /not found|missing|stale/i.test(rawMessage)) {
    return {
      title: 'Session unavailable',
      description: 'This session points to a stale compute node and could not be restored.',
    };
  }
  return {
    title: 'Session unavailable',
    description: rawMessage || 'Failed to restore this session.',
  };
}

/**
 * Load an AgenticProcess by id and set it as the active session.
 *
 * Throws a redirect on any failure (not found / start error / missing shell)
 * so the caller (a react-router loader) returns control to the router.
 */
export async function loadAgenticProcessFromPointer(
  processId: string,
  recoverySkips: ShellRecoverySkips,
): Promise<void> {
  // Cache-first: tab switches between live sessions should not hit the backend.
  // `useActiveTerminals` keeps the cache warm via a live entity subscription.
  const process =
    AgenticProcess.getByIdFromCache<AgenticProcess>(processId) ??
    (await AgenticProcess.getById<AgenticProcess>(processId).catch(() => null));
  if (!process) {
    toast({ title: 'Session not found', description: 'Agentic process does not exist.', variant: 'destructive' });
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect('/dock/shell');
  }

  let shell: import('@sdk/entities/shell').Shell | null = null;
  try {
    await process.start({ visible: true });
    shell = await process.shell();
  } catch (error) {
    const recoveryUrl = buildShellRecoveryUrl(appendRecoverySkip(recoverySkips, process.id, process.shell_id));
    const toastInfo = describeProcessStartError(error);
    toast({ ...toastInfo, variant: 'destructive' });
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect(recoveryUrl);
  }

  if (!shell) {
    const recoveryUrl = buildShellRecoveryUrl(appendRecoverySkip(recoverySkips, process.id, process.shell_id));
    toast({ title: 'Session unavailable', description: 'No shell is linked to this process.', variant: 'destructive' });
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect(recoveryUrl);
  }

  dataContext.setActiveShellId(shell.id);
  dataContext.setWorkdir(process.workdir ?? shell.workdir ?? dataContext.project?.fs_storage_mount_path ?? null);
  await dataContext.setContextEntityTypeId(
    ContextEntitiesEnum.CurrentProcessTypeId,
    new TypeId(AgenticProcess.type, processId),
  );
  if (process.project_id) {
    await dataContext.setContextEntityTypeId(
      ContextEntitiesEnum.CurrentProjectTypeId,
      new TypeId(Project.type, process.project_id),
    );
  } else {
    await systemTools.resolveProjectContext(process.workdir, process);
  }
}
