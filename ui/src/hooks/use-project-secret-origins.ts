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
 * Project secrets hook — the Connections table reads everything here.
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

  /** Declare several at once — one project save, so no link can be lost. */
  const addMany = useCallback(
    async (entries: Parameters<Project['addSecretPointers']>[0]) => {
      const p = projectRef.current;
      if (!p || !entries.length) return;
      await p.addSecretPointers(entries);
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

  /**
   * Stop declaring several at once — N removes, but ONE refresh.
   *
   * The mirror of {@link addMany}, and not as good: `remove-secret-pointer` is a
   * single-pointer action on the backend, so there is no batch to call and this
   * is still N round-trips that can fail half-way. What it does fix is the other
   * half of the cost — `remove` refetches the whole resolve-status after every
   * call, so undeclaring a three-variable credential used to mean three writes
   * AND three full refetches, with the table re-rendering between each.
   */
  const removeMany = useCallback(
    async (typeids: string[]) => {
      const p = projectRef.current;
      if (!p || !typeids.length) return;
      for (const typeid of typeids) {
        if (typeid) await p.removeSecretPointer(typeid);
      }
      await refreshStatus();
    },
    [refreshStatus],
  );

  return {
    secretOrigins,
    status,
    statusReady,
    addMany,
    provide,
    remove,
    removeMany,
    refreshStatus,
  } as const;
}
