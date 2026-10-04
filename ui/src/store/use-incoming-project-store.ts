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
}

interface IncomingProjectState {
  pendingProject: IncomingProjectParams | null;
  setPendingProject: (params: IncomingProjectParams | null) => void;
}

export const useIncomingProjectStore = create<IncomingProjectState>((set) => ({
  pendingProject: null,
  setPendingProject: (params) => set({ pendingProject: params }),
}));
