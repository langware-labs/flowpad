import { useCallback, useEffect, useRef, useState } from 'react';
import type { EnvLocalKey, EnvLocalStatus, Project } from '@sdk';

/**
 * The project's `.env.local`, as the Secrets tab sees it.
 *
 * Headless: every decision — which keys exist, which are already declared,
 * whether writing is blocked — is the backend's. This hook only calls the
 * action and holds the result.
 *
 * The response carries key NAMES and line numbers, never values, so there is
 * nothing here to leak into a render.
 */
/** Stable while loading — a fresh `[]` per render churns every memo that takes
 *  `keys` as a dependency, which re-runs the credential fold on every render. */
const NO_KEYS: EnvLocalKey[] = [];

export function useProjectEnvLocal(project: Project | null | undefined) {
  const projectRef = useRef<Project | null>(null);
  projectRef.current = project ?? null;

  const [status, setStatus] = useState<EnvLocalStatus | null>(null);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    const p = projectRef.current;
    if (!p) return;
    try {
      const next = await p.envLocalStatus();
      if (projectRef.current === p) setStatus(next);
    } catch {
      /* best-effort; keep the last snapshot rather than blanking the table */
    } finally {
      if (projectRef.current === p) setReady(true);
    }
  }, []);

  useEffect(() => {
    if (!project?.id) return;
    setReady(false);
    void refresh();
  }, [project?.id, refresh]);

  /** Promote a detected key into a declaration.
   *
   *  Purely additive: it writes a declaration and does NOT touch `.env.local`.
   *  The project's own tooling (vite, dotenv, …) reads that file, and keeping
   *  it in sync is not ours to decide. */
  const declare = useCallback(
    async (key: string) => {
      const p = projectRef.current;
      if (!p || !key) return;
      await p.addSecretPointer(key, key, {
        locator: { kind: 'env-local', env_key: key },
        scope: 'private',
        sodStore: 'env-local',
      });
      await refresh();
    },
    [refresh],
  );

  return {
    ready,
    keys: status?.keys ?? NO_KEYS,
    blocked: status?.blocked ?? false,
    blockReason: status?.block_reason ?? null,
    path: status?.path ?? null,
    refresh,
    declare,
  } as const;
}
