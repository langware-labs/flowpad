import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project, ProjectSecretOriginSummary, SecretResolveStatus } from '@sdk';

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

  /**
   * Delete: the declarations AND the values we are allowed to delete.
   *
   * One backend call for N pointers, because deleting is one act with one
   * outcome to report — and the answer says which values actually went, so the
   * caller can tell the user the truth about the ones that stayed.
   */
  const deleteMany = useCallback(
    async (typeids: string[]): Promise<{ deleted: string[]; kept: string[] }> => {
      const p = projectRef.current;
      if (!p || !typeids.length) return { deleted: [], kept: [] };
      const result = await p.deleteSecrets(typeids);
      await refreshStatus();
      return result;
    },
    [refreshStatus],
  );

  return {
    secretOrigins,
    status,
    statusReady,
    addMany,
    provide,
    deleteMany,
    refreshStatus,
  } as const;
}
