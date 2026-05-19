/**
 * Track which AttentionItems the user has dismissed this session.
 *
 * Session-storage (not local-storage): dismissals reset when the tab
 * closes. Scoped per workflow id so dismissing on workflow A doesn't
 * silence workflow B.
 */

import { useCallback, useEffect, useState } from 'react';

const KEY_PREFIX = 'workflowRunner.dismissedAttentions';

function storageKey(workflowId: string): string {
  return `${KEY_PREFIX}:${workflowId}`;
}

function readDismissed(workflowId: string): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.sessionStorage.getItem(storageKey(workflowId));
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeDismissed(workflowId: string, set: Set<string>) {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(storageKey(workflowId), JSON.stringify([...set]));
  } catch {
    /* ignore — full storage / private mode */
  }
}

export interface UseDismissedAttentionsResult {
  isDismissed: (id: string) => boolean;
  dismiss: (id: string) => void;
  restoreAll: () => void;
}

export function useDismissedAttentions(workflowId: string): UseDismissedAttentionsResult {
  const [dismissed, setDismissed] = useState<Set<string>>(() => readDismissed(workflowId));

  useEffect(() => {
    setDismissed(readDismissed(workflowId));
  }, [workflowId]);

  useEffect(() => {
    writeDismissed(workflowId, dismissed);
  }, [workflowId, dismissed]);

  const isDismissed = useCallback((id: string) => dismissed.has(id), [dismissed]);

  const dismiss = useCallback((id: string) => {
    setDismissed((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const restoreAll = useCallback(() => {
    setDismissed(new Set());
  }, []);

  return { isDismissed, dismiss, restoreAll };
}
