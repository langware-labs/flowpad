/**
 * Pure publish-state model — shared by the per-asset pill and (later) the project
 * footer. No React, no fetching: maps a git status snapshot to a discrete state,
 * and maps state/outcome to user-facing copy that respects the Standard/Advanced
 * view mode (Standard never leaks git jargon). Headless model + copy → lives in
 * `lib/` (peer to scope-filter / color-palette), not in a components dir.
 */

import { ViewMode } from '@src/components/view-mode';

export type PublishState = 'no-repo' | 'local-only' | 'aligned' | 'unpublished';

/** Typed push outcome from the backend (`GitRepo._classify_push_error`). */
export type PushKind =
  | 'pushed' | 'nothing' | 'conflict' | 'permission'
  | 'no_remote' | 'network' | 'no_repo' | 'generic';

export interface PublishStatusInput {
  hasRepo: boolean;
  /** Commits ahead of the remote for this scope (per-file for assets). */
  unpushed: number;
  /** Working-tree changes — footer scope only; assets auto-commit so omit. */
  uncommitted?: number;
  /** Whether a tracking remote exists. Footer passes it; assets omit. */
  hasUpstream?: boolean;
}

export interface PublishStatus {
  state: PublishState;
  pendingCount: number;
}

export function derivePublishState(input: PublishStatusInput): PublishStatus {
  if (!input.hasRepo) {
    return { state: 'no-repo', pendingCount: 0 };
  }
  const pending = input.unpushed + (input.uncommitted ?? 0);
  if (pending > 0) {
    return { state: 'unpublished', pendingCount: pending };
  }
  // Nothing pending: distinguish a remote-tracked-and-current branch from a
  // local-only repo (no remote). Only the footer passes hasUpstream; for assets
  // it's undefined and both render identically (just the version, no Publish).
  const state: PublishState = input.hasUpstream === false ? 'local-only' : 'aligned';
  return { state, pendingCount: 0 };
}

const isAdvanced = (mode: ViewMode): boolean => mode !== ViewMode.Standard;

export interface PublishLabels {
  /** Button label for the publish action. */
  publishLabel: string;
  /** Tooltip on the publish affordance. */
  publishTitle: string;
  /** Whether to show the raw pending count next to Publish (Advanced only). */
  showCount: boolean;
}

/** Copy for the pill's Publish affordance, by state + mode. */
export function publishCopy(state: PublishState, mode: ViewMode): PublishLabels {
  const advanced = isAdvanced(mode);
  return {
    publishLabel: 'Publish',
    publishTitle: advanced
      ? 'Publish your changes to the remote'
      : 'Publish your changes',
    showCount: advanced,
  };
}

export interface PushToast {
  level: 'success' | 'error';
  title: string;
  message: string;
  /** Advanced-only: offer the git conflict-resolver agent. */
  resolvable: boolean;
}

/**
 * Plain-language toast for a push outcome. Standard mode contains no git terms;
 * Advanced may include branch/remote detail and the Resolve-conflict action.
 */
export function pushToastCopy(
  kind: PushKind,
  mode: ViewMode,
  opts: { branch?: string | null; message?: string } = {},
): PushToast {
  const advanced = isAdvanced(mode);
  const raw = opts.message?.trim() || '';
  switch (kind) {
    case 'pushed':
      return {
        level: 'success',
        title: 'Published',
        message: advanced && opts.branch ? `Pushed to ${opts.branch}.` : 'Your changes are now published.',
        resolvable: false,
      };
    case 'nothing':
      return { level: 'success', title: 'Nothing to publish', message: 'Everything is already up to date.', resolvable: false };
    case 'conflict':
      return advanced
        ? { level: 'error', title: 'Publish hit a conflict', message: raw || 'A rebase conflict is in progress.', resolvable: true }
        : { level: 'error', title: "Couldn't publish", message: 'Someone else changed this too. Switch to Advanced view to merge.', resolvable: false };
    case 'permission':
      return {
        level: 'error',
        title: advanced ? 'Push rejected — no access' : "Can't publish here",
        message: advanced ? (raw || 'You do not have write access to this remote.') : "You don't have access to publish to this location.",
        resolvable: false,
      };
    case 'no_remote':
      return {
        level: 'error',
        title: advanced ? 'No remote configured' : 'Nowhere to publish yet',
        message: advanced ? (raw || 'No git remote/upstream is configured for this branch.') : "This project isn't connected to a place to publish to.",
        resolvable: false,
      };
    case 'network':
      return { level: 'error', title: "Couldn't reach the server", message: 'Check your connection and try again.', resolvable: false };
    case 'no_repo':
      return { level: 'error', title: 'Not set up for publishing', message: 'This file is not in a versioned project.', resolvable: false };
    default:
      return {
        level: 'error',
        title: advanced ? 'Push failed' : "Couldn't publish",
        message: advanced ? (raw || 'Push failed.') : 'Something went wrong. Please try again.',
        resolvable: false,
      };
  }
}
