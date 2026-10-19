import { create } from 'zustand';
import type { ProjectOrigin } from '@sdk/models/FSOrigin';

/**
 * A pending "X shared a project with you" template launch. Set from the
 * desktop deep-link params (``?project_template=1&git_origin=…``) that the
 * launcher stamps onto the opened box URL. The box-side ``IncomingProjectDialog``
 * consumes it: clone the template git repo into a fresh Project (server-side
 * ``create-project-from-git``, which also indexes) and open it.
 */
export interface IncomingProjectParams {
  /** Where the project's files come from: a git repo (a template, or a shared
   *  project's own remote) or its hub-hosted copy. Required — the whole payload. */
  gitOrigin: ProjectOrigin;
  /** Display name for the copy ("… shared <projectName> with you"). */
  projectName: string;
  senderName: string;
  /**
   * The SHARED project's id, when this came from a membership grant rather than
   * a template deep link. Present means "materialize this row in place"
   * (`setup-from-git`) instead of minting a fresh project from the template:
   * the recipient's local project then carries the same id the hub and the
   * sender use, so roles, membership and later shares all line up.
   */
  projectId?: string;
  /** The shared project's name is already a project here: instead of setting it up,
   *  ask — open that one, or install the shared one under another name. */
  nameTaken?: { existingProjectId: string; suggestedName: string };
}

interface IncomingProjectState {
  pendingProject: IncomingProjectParams | null;
  setPendingProject: (params: IncomingProjectParams | null) => void;
}

export const useIncomingProjectStore = create<IncomingProjectState>((set) => ({
  pendingProject: null,
  setPendingProject: (params) => set({ pendingProject: params }),
}));

const DECLINED_KEY = 'flowpad:shared-project-setup-declined';

function declinedIds(): string[] {
  try {
    const ids: unknown = JSON.parse(window.localStorage.getItem(DECLINED_KEY) || '[]');
    return Array.isArray(ids) ? ids.map(String) : [];
  } catch {
    return [];
  }
}

/** The person ticked "Don't ask me again" on this project's set-up: it is not offered on its
 *  own any more. Their own click (the footer's "Set up") still opens it. */
export function isSetupDeclined(projectId: string | undefined): boolean {
  return !!projectId && declinedIds().includes(projectId);
}

export function declineSetup(projectId: string): void {
  if (isSetupDeclined(projectId)) return;
  try {
    window.localStorage.setItem(DECLINED_KEY, JSON.stringify([...declinedIds(), projectId]));
  } catch {
    /* storage unavailable — the offer comes back next time, nothing worse */
  }
}
