import type { GitPullResult, GitPushResult } from '@sdk';
import { getTierMode } from '@src/components/view-mode';
import { notify } from '@src/notifications/notify';
import type { NotificationAction } from '@src/notifications/types';
import { gitOutcomeCopy, type GitSyncOp } from '@src/lib/publish-state';

/**
 * The ONE place a git sync result becomes what the user sees. Every surface
 * that pushes or pulls (footer buttons, Git panel, asset Publish, share gate,
 * context-folder Push, incoming-task pull) hands its result here, so a conflict
 * reads the same everywhere and always carries the same Resolve.
 */

/** The Resolve action for a conflicted tree — the only launcher of the resolver. */
export function resolveConflictAction(op: GitSyncOp, branch: string | null | undefined, workdir: string): NotificationAction {
  return { label: 'Resolve', command: 'git.resolve-conflict', args: { branch: branch ?? '', origin: op, workdir } };
}

type SyncResult = Pick<GitPushResult | GitPullResult, 'kind' | 'branch' | 'message'>;

/**
 * A conflict toast is sticky, so it carries a stable id per repo: a second
 * conflict replaces it instead of stacking, and whoever next sees that repo
 * clean (`closeGitConflict`) can take it down — the resolver usually finishes
 * outside the UI, so nothing else would.
 */
function gitConflictToastId(workdir: string): string {
  return `git.conflict:${workdir}`;
}

/** The repo is clean again: take its conflict toast, and its alert-log entry, down. */
export function closeGitConflict(workdir: string): void {
  notify.dismiss(gitConflictToastId(workdir));
}

/**
 * Toast a push/pull outcome in the repo at `workdir`. Success is brief; an
 * error is sticky and pops in every view (it is the only answer to the click).
 */
export function notifyGitOutcome(op: GitSyncOp, result: SyncResult, workdir: string) {
  const copy = gitOutcomeCopy(op, result.kind, getTierMode(), { branch: result.branch, message: result.message });
  if (copy.level === 'success') {
    notify.success({ title: copy.title, message: copy.message, durationMs: 4000 });
    return;
  }
  notify.error({
    ...(copy.resolvable ? { id: gitConflictToastId(workdir) } : {}),
    title: copy.title,
    message: copy.message,
    durationMs: null,
    forceToast: true,
    actions: copy.resolvable ? [resolveConflictAction(op, result.branch, workdir)] : undefined,
  });
}

/** Toast a sync that threw before git could answer. */
export function notifyGitFailure(op: GitSyncOp, e: unknown, workdir: string) {
  notifyGitOutcome(op, { kind: 'generic', branch: null, message: e instanceof Error ? e.message : String(e) }, workdir);
}
