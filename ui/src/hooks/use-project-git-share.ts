/**
 * A project's git share, for the project page: whether its private GitHub repo is
 * shared with its members through the hub, and the verbs to change that.
 *
 * Reads `project.gitShare()` when the project is linked to the cloud (an unlinked
 * project has no members to share with, so nothing is asked). `enable()` and
 * `disable()` run `shareGit()` / `unshareGit()` and keep the answer — including
 * the next GitHub step a share can ask for (`install_required`,
 * `github_connect_required`), which the caller shows and retries with `enable()`.
 */
import type { GitShare, Project } from '@sdk';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface ProjectGitShareState {
  share: GitShare | null;
  /** The first read is in flight. */
  loading: boolean;
  /** A share/unshare is in flight. */
  busy: boolean;
  /** Why the last read or change failed, in the backend's words. */
  error: string | null;
  enable: () => Promise<GitShare | null>;
  disable: () => Promise<GitShare | null>;
  refetch: () => void;
}

function messageOf(error: unknown): string {
  const data = (error as { response?: { data?: { message?: string } } })?.response?.data;
  if (data?.message) return data.message;
  return error instanceof Error ? error.message : String(error);
}

export function useProjectGitShare(project: Project | null | undefined): ProjectGitShareState {
  const [share, setShare] = useState<GitShare | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const mountedRef = useRef(true);
  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  const linked = !!project?.remote;
  const projectId = project?.id ?? '';

  useEffect(() => {
    mountedRef.current = true;
    if (!project || !linked) {
      setShare(null);
      setLoading(false);
      return () => {
        mountedRef.current = false;
      };
    }
    setLoading(true);
    void project
      .gitShare()
      .then((next) => {
        if (!mountedRef.current) return;
        setShare(next);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (mountedRef.current) setError(messageOf(cause));
      })
      .finally(() => {
        if (mountedRef.current) setLoading(false);
      });
    return () => {
      mountedRef.current = false;
    };
    // projectId stands in for the project's identity; nonce re-reads on `refetch()`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, linked, nonce]);

  const run = useCallback(
    async (verb: (p: Project) => Promise<GitShare>): Promise<GitShare | null> => {
      if (!project) return null;
      setBusy(true);
      setError(null);
      try {
        const next = await verb(project);
        if (mountedRef.current) setShare(next);
        return next;
      } catch (cause: unknown) {
        if (mountedRef.current) setError(messageOf(cause));
        return null;
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [project],
  );

  const enable = useCallback(() => run((p) => p.shareGit()), [run]);
  const disable = useCallback(() => run((p) => p.unshareGit()), [run]);

  return { share, loading, busy, error, enable, disable, refetch };
}
