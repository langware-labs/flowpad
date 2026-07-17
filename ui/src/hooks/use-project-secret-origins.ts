import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Project,
  ProjectSecretOriginSummary,
  SecretOriginLocator,
  SecretPointerScope,
  SecretResolveStatus,
  SodStore,
} from '@sdk';

/**
 * Project secrets hook — the Secrets card + setup wizard read everything here.
 * The backend owns all logic (value-free pointers, driver resolution, stores);
 * this hook only calls actions and surfaces their results (headless FE).
 */
export function useProjectSecretOrigins(project: Project | null | undefined) {
  const projectRef = useRef<Project | null>(null);
  projectRef.current = project ?? null;

  const secretOrigins = useMemo<ProjectSecretOriginSummary[]>(
    () => (project?.secret_origins ?? []).filter((s): s is ProjectSecretOriginSummary => !!s?.typeid),
    [project?.secret_origins],
  );

  const [status, setStatus] = useState<SecretResolveStatus[]>([]);
  const [statusReady, setStatusReady] = useState(false);

  const refreshStatus = useCallback(async () => {
    const p = projectRef.current;
    if (!p) return;
    try {
      const rows = await p.secretResolveStatus();
      if (projectRef.current === p) setStatus(rows);
    } catch {
      /* value-free status is best-effort; keep the last snapshot */
    } finally {
      if (projectRef.current === p) setStatusReady(true);
    }
  }, []);

  // Refresh resolve-status whenever the set of secrets changes.
  const secretsKey = secretOrigins.map((s) => s.typeid).join(',');
  useEffect(() => {
    if (!project?.id) return;
    setStatusReady(false);
    void refreshStatus();
  }, [project?.id, secretsKey, refreshStatus]);

  /** Add a value-free secret pointer: the provider (where to fetch), the SOD
   *  store (how to store a provided value), and the env var (how to use it). */
  const add = useCallback(
    async (opts: {
      name: string;
      envVar: string;
      locator: SecretOriginLocator;
      sodStore?: SodStore;
      scope?: SecretPointerScope;
    }) => {
      const p = projectRef.current;
      if (!p || !opts.envVar || !opts.locator) return;
      await p.addSecretPointer(opts.name || opts.envVar, opts.envVar, {
        locator: opts.locator,
        scope: opts.scope ?? 'private',
        sodStore: opts.sodStore,
      });
      await refreshStatus();
    },
    [refreshStatus],
  );

  /** Setup wizard: store a provided value in the secret's designated SOD store. */
  const provide = useCallback(
    async (params: { typeid?: string; envVar?: string; value: string }) => {
      const p = projectRef.current;
      if (!p || !params.value) return;
      await p.provideSecret(params);
      await refreshStatus();
    },
    [refreshStatus],
  );

  const remove = useCallback(
    async (typeid: string) => {
      const p = projectRef.current;
      if (!p || !typeid) return;
      await p.removeSecretPointer(typeid);
      await refreshStatus();
    },
    [refreshStatus],
  );

  return { secretOrigins, status, statusReady, add, provide, remove, refreshStatus } as const;
}
