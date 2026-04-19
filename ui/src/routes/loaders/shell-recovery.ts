/**
 * Shell/process recovery URL helpers.
 *
 * When a shell or process fails to restore during the default-shell redirect,
 * the failing ids get encoded into the URL (`skip_process_id`, `skip_shell_id`)
 * so the next redirect can skip them and avoid a redirect loop.
 */

export const SKIP_PROCESS_ID_PARAM = 'skip_process_id';
export const SKIP_SHELL_ID_PARAM = 'skip_shell_id';

export type ShellRecoverySkips = {
  skipProcessIds: Set<string>;
  skipShellIds: Set<string>;
};

export function emptyRecoverySkips(): ShellRecoverySkips {
  return {
    skipProcessIds: new Set(),
    skipShellIds: new Set(),
  };
}

export function parseRecoverySkipsFromUrl(searchParams: URLSearchParams): ShellRecoverySkips {
  return {
    skipProcessIds: new Set(searchParams.getAll(SKIP_PROCESS_ID_PARAM).filter(Boolean)),
    skipShellIds: new Set(searchParams.getAll(SKIP_SHELL_ID_PARAM).filter(Boolean)),
  };
}

export function buildShellRecoveryUrl(recoverySkips: ShellRecoverySkips = emptyRecoverySkips()): string {
  const queryString = serializeSkips(recoverySkips);
  return queryString ? `/dock/shell?${queryString}` : '/dock/shell';
}

export function withRecoverySearch(path: string, recoverySkips: ShellRecoverySkips): string {
  const queryString = serializeSkips(recoverySkips);
  return queryString ? `${path}?${queryString}` : path;
}

export function appendRecoverySkip(
  recoverySkips: ShellRecoverySkips,
  processId?: string | null,
  shellId?: string | null,
): ShellRecoverySkips {
  const nextProcessIds = new Set(recoverySkips.skipProcessIds);
  const nextShellIds = new Set(recoverySkips.skipShellIds);
  if (processId) nextProcessIds.add(processId);
  if (shellId) nextShellIds.add(shellId);
  return {
    skipProcessIds: nextProcessIds,
    skipShellIds: nextShellIds,
  };
}

function serializeSkips(recoverySkips: ShellRecoverySkips): string {
  const searchParams = new URLSearchParams();
  for (const processId of recoverySkips.skipProcessIds) {
    searchParams.append(SKIP_PROCESS_ID_PARAM, processId);
  }
  for (const shellId of recoverySkips.skipShellIds) {
    searchParams.append(SKIP_SHELL_ID_PARAM, shellId);
  }
  return searchParams.toString();
}
