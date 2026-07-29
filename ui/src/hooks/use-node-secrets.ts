import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComputeNode, Project } from '@sdk';

export interface NodeSecretRow {
  env_var: string;
  attached: boolean;
}

/**
 * Which of a project's declared secrets a compute node may see.
 *
 * Headless: the backend decides what is declared, what is attached, and what an
 * uncurated node means. This hook calls the actions and holds the answer.
 *
 * `allAttached` is true when nothing has been curated yet — the node is
 * unrestricted. The UI shows every row checked, which is honest, rather than
 * implying someone picked them.
 */
export function useNodeSecrets(
  node: ComputeNode | null | undefined,
  project: Project | null | undefined,
) {
  const nodeRef = useRef<ComputeNode | null>(null);
  nodeRef.current = node ?? null;
  const projectId = project?.id ?? '';

  const [rows, setRows] = useState<NodeSecretRow[]>([]);
  const [allAttached, setAllAttached] = useState(true);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    const n = nodeRef.current;
    if (!n || !projectId) {
      setRows([]);
      setReady(true);
      return;
    }
    try {
      const res = await n.listAttachedSecrets(projectId);
      if (nodeRef.current !== n) return;
      setRows(res?.secrets ?? []);
      setAllAttached(res?.all_attached ?? true);
    } catch {
      /* best-effort; keep the last snapshot */
    } finally {
      if (nodeRef.current === n) setReady(true);
    }
  }, [projectId]);

  useEffect(() => {
    setReady(false);
    void refresh();
  }, [node?.id, projectId, refresh]);

  const toggle = useCallback(
    async (envVar: string, attach: boolean) => {
      const n = nodeRef.current;
      if (!n || !projectId) return;
      if (attach) await n.attachSecret(projectId, envVar);
      else await n.detachSecret(projectId, envVar);
      await refresh();
    },
    [projectId, refresh],
  );

  const attachAll = useCallback(async () => {
    const n = nodeRef.current;
    if (!n || !projectId) return;
    await n.attachAllSecrets(projectId);
    await refresh();
  }, [projectId, refresh]);

  return { rows, allAttached, ready, refresh, toggle, attachAll } as const;
}
