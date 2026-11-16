import type { GitPullResult, GitPushResult } from '@sdk';
import { getTierMode } from '@src/components/view-mode';
import { notify } from '@src/notifications/notify';
import type { NotificationAction } from '@src/notifications/types';
import { gitOutcomeCopy, type GitSyncOp } from '@src/lib/publish-state';

/**
 * The ONE place a git sync result becomes what the user sees. Every surface
 * that pushes or pulls (footer buttons, Git panel, asset Publish, share gate,
 * context-folder Push, incoming-task pull) hands its result here. A conflict
 * is shown only by the footer's Resolve chip, never as an alert.
 */

/** The Resolve action for a conflicted tree — the only launcher of the resolver. */
export function resolveConflictAction(op: GitSyncOp, branch: string | null | undefined, workdir: string): NotificationAction {
  return { label: 'Resolve', command: 'git.resolve-conflict', args: { branch: branch ?? '', origin: op, workdir } };
}

type SyncResult = Pick<GitPushResult | GitPullResult, 'kind' | 'branch' | 'message'>;

/**
 * Toast a push/pull outcome in the repo at `workdir`. Success is brief; an
 * error is sticky and pops in every view (it is the only answer to the click).
 */
export function notifyGitOutcome(op: GitSyncOp, result: SyncResult, _workdir: string, quietSuccess = false): boolean {
  const copy = gitOutcomeCopy(op, result.kind, getTierMode(), { branch: result.branch, message: result.message });
  if (copy.level === 'success') {
    if (!quietSuccess) notify.success({ title: copy.title, message: copy.message, durationMs: 4000 });
    return true;
  }
  // A conflict has its own footer chip with Resolve; a second alert would only repeat it.
  if (copy.resolvable) return false;
  notify.error({
    title: copy.title,
    message: copy.message,
    durationMs: null,
    forceToast: true,
  });
  return false;
}

/** Toast a sync that threw before git could answer. */
export function notifyGitFailure(op: GitSyncOp, e: unknown, workdir: string) {
  notifyGitOutcome(op, { kind: 'generic', branch: null, message: e instanceof Error ? e.message : String(e) }, workdir);
}

/** A git share whose pull / cherry-pick conflicted: the same toast and Resolve as any sync. */
export function notifyShareConflict(c: { operation?: string; branch?: string | null; workdir: string; message?: string }) {
  const op: GitSyncOp = c.operation === 'pull' ? 'pull' : 'cherry-pick';
  notifyGitOutcome(op, { kind: 'conflict', branch: c.branch ?? null, message: c.message ?? '' }, c.workdir);
}
