import { ActionInfo, dataManager, Project, type TypeId } from '@sdk';
import {
  NewProjectFromGitDialog,
  useEnsureProject,
  useSelectExistingProject,
} from '@src/components/project-selector';
import { notify } from '@src/notifications';
import { useCallback, useEffect, useState } from 'react';

/** Known git hosts, keyed by the short provider name a GitRemote carries. An
 *  unknown provider is itself the host (mirrors the backend's
 *  `git_remote_https_url`). */
const PROVIDER_HOSTS: Record<string, string> = {
  github: 'github.com',
  gitlab: 'gitlab.com',
  bitbucket: 'bitbucket.org',
};

function gitHttpsUrl(provider: string, owner: string, name: string): string {
  const host = PROVIDER_HOSTS[provider.trim().toLowerCase()] ?? provider.trim();
  return `https://${host}/${owner}/${name.replace(/\.git$/, '')}.git`;
}

/** Locate a local clone whose `origin` matches `url` (url-only counterpart of
 *  the task-scoped find-project). Returns its path, or null. */
async function findLocalRepo(url: string): Promise<string | null> {
  const action = new ActionInfo('find-local-repo', 'compute_node', '@local', 'POST');
  action.bodyParameters = { project_url: url };
  try {
    const res = await dataManager.callAction<{ project_url: string }, { found: boolean; local_path: string | null }>(
      action,
    );
    return res?.found ? res.local_path : null;
  } catch {
    return null;
  }
}

/**
 * Receiver side of a shared git repo. Reads the shared ``GitBranch`` entity's
 * coordinates, then opens the same ``NewProjectFromGitDialog`` the
 * clone-from-git flow uses — pre-filled with the remote URL + branch. The
 * create handler first checks for a local clone the receiver already has
 * (attach), falling back to a fresh clone (pull as a project from the remote).
 */
export function SharedRepoDialog({
  gitBranchTypeId,
  onClose,
}: {
  gitBranchTypeId: TypeId;
  onClose: () => void;
}) {
  const ensureProject = useEnsureProject();
  const selectExisting = useSelectExistingProject();
  const [coords, setCoords] = useState<{ url: string; branch?: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const entity = await dataManager.getByTypeId(gitBranchTypeId);
        const raw = (entity?.toJSON?.() ?? {}) as {
          provider?: string;
          owner?: string;
          name?: string;
          branch?: string;
        };
        if (cancelled) return;
        if (!raw.owner || !raw.name) {
          notify.error({ title: 'This shared repo is missing its coordinates.' });
          onClose();
          return;
        }
        setCoords({
          url: gitHttpsUrl(raw.provider ?? 'github', raw.owner, raw.name),
          branch: raw.branch || undefined,
        });
      } catch {
        if (cancelled) return;
        notify.error({ title: 'Could not load the shared repo.' });
        onClose();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gitBranchTypeId, onClose]);

  const onCreate = useCallback(
    async (
      url: string,
      acceptSuggested?: string,
      branch?: string,
    ): Promise<{ ok: true } | { ok: false; suggestedName: string; attemptedName: string }> => {
      // Attach to a clone the receiver already has — but only on the first
      // attempt. Once they've accepted a fresh name, they want a new clone.
      if (!acceptSuggested) {
        const found = await findLocalRepo(url);
        if (found) {
          await ensureProject(found);
          return { ok: true };
        }
      }
      const result = await Project.createFromGitUrl('@local', url, acceptSuggested, branch);
      if (result.kind === 'ok') {
        await selectExisting(result.project);
        return { ok: true };
      }
      if (result.kind === 'collision') {
        return { ok: false, suggestedName: result.suggestedName, attemptedName: result.attemptedName };
      }
      throw new Error(result.message);
    },
    [ensureProject, selectExisting],
  );

  if (!coords) return null;
  return (
    <NewProjectFromGitDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      initialUrl={coords.url}
      initialBranch={coords.branch}
      onCreate={onCreate}
    />
  );
}

export default SharedRepoDialog;
