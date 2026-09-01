import { useCallback, useMemo, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { AgentDocumentListKey, AgentDocumentPatch } from '@src/components/assets/editor/agent-profile/agent-document';
import { notify } from '@src/notifications';
import type { AgentDocument } from './useAgentDocument';

export interface ListWiring {
  /** Serialized TypeIds currently declared in the document. */
  declared: Set<string>;
  /** The one row whose write is in flight, or null. */
  pendingId: string | null;
  /** Attach/detach by serialized TypeId. No-op until the document is readable. */
  toggle: (id: string, next: boolean) => Promise<void>;
}

/**
 * Read/write of one declared list on `agent.md`. The stored value is always a
 * serialized TypeId, never a name: the model types these `list[TypeId]`, and a
 * bare name breaks indexing. Document-derived, not optimistic.
 */
export function useAgentListWiring(doc: AgentDocument, key: AgentDocumentListKey): ListWiring {
  const { t } = useLingui();
  const [pendingId, setPendingId] = useState<string | null>(null);

  const declaredList = doc.list(key);
  // Memoized on the joined ids: consumers use this in their own `useMemo` deps,
  // and a fresh Set each render would defeat every one of them.
  const declaredKey = declaredList.join(' ');
  const declared = useMemo(() => new Set(declaredKey ? declaredKey.split(' ') : []), [declaredKey]);

  const toggle = useCallback(
    async (id: string, next: boolean) => {
      if (!doc.ready || !id) return;

      setPendingId(id);
      try {
        const current = doc.list(key);
        const updated = next ? [...current, id] : current.filter((entry) => entry !== id);
        await doc.commit({ [key]: updated } as AgentDocumentPatch);
      } catch (err) {
        notify.error({
          title: t`Couldn't update the agent`,
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setPendingId(null);
      }
    },
    [doc, key, t],
  );

  return { declared, pendingId, toggle };
}
