import { ActionInfo, dataManager } from '@sdk';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface QueueEntry {
  queue_entry_type: 'prompt';
  queue_entry_data: { prompt: string };
  delay?: number;
}

export interface QueueState {
  enabled: boolean;
  entries: QueueEntry[];
}

const DEFAULT_QUEUE: QueueState = { enabled: true, entries: [] };

export function useAgenticQueue(
  processId: string | undefined,
  isActive: boolean | undefined,
  shellRef: React.RefObject<{ sendInput: (text: string) => Promise<void> } | null>,
) {
  const [queue, setQueue] = useState<QueueState>(DEFAULT_QUEUE);
  const [windowOpen, setWindowOpen] = useState(false);
  const prevIsActive = useRef<boolean | undefined>(isActive);

  const fetchQueue = useCallback(async () => {
    if (!processId) return;
    const action = new ActionInfo('queue', 'agentic_process', processId, 'GET');
    try {
      const result = await dataManager.callAction<undefined, QueueState>(action);
      if (result) setQueue(result);
    } catch {
      // ignore
    }
  }, [processId]);

  const saveQueue = useCallback(async (data: Partial<QueueState>) => {
    if (!processId) return;
    const action = new ActionInfo('queue', 'agentic_process', processId, 'POST');
    action.bodyParameters = data as Record<string, unknown>;
    try {
      const result = await dataManager.callAction<Partial<QueueState>, QueueState>(action);
      if (result) setQueue(result);
    } catch {
      // ignore
    }
  }, [processId]);

  const addEntry = useCallback(async (entry: QueueEntry) => {
    const newEntries = [...(queue.entries ?? []), entry];
    await saveQueue({ entries: newEntries });
  }, [queue.entries, saveQueue]);

  const removeEntry = useCallback(async (index: number) => {
    const newEntries = (queue.entries ?? []).filter((_, i) => i !== index);
    await saveQueue({ entries: newEntries });
  }, [queue.entries, saveQueue]);

  const setEnabled = useCallback(async (enabled: boolean) => {
    await saveQueue({ enabled });
  }, [saveQueue]);

  const moveEntry = useCallback(async (index: number, direction: 'up' | 'down') => {
    const newEntries = [...(queue.entries ?? [])];
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= newEntries.length) return;
    [newEntries[index], newEntries[targetIndex]] = [newEntries[targetIndex], newEntries[index]];
    await saveQueue({ entries: newEntries });
  }, [queue.entries, saveQueue]);

  // Fetch queue on mount
  useEffect(() => {
    void fetchQueue();
  }, [fetchQueue]);

  // Idle injection logic
  useEffect(() => {
    if (prevIsActive.current === true && isActive === false) {
      // just went idle
      if (queue.enabled && (queue.entries ?? []).length > 0) {
        const entry = queue.entries[0];
        const delayMs = (entry.delay ?? 0) * 1000;
        const doInject = () => {
          if (entry.queue_entry_type === 'prompt') {
            void shellRef.current?.sendInput(entry.queue_entry_data.prompt + '\n');
          }
          void removeEntry(0);
        };
        if (delayMs > 0) {
          setTimeout(doInject, delayMs);
        } else {
          doInject();
        }
      }
    }
    prevIsActive.current = isActive;
  }, [isActive, queue, removeEntry, shellRef]);

  return { queue, addEntry, removeEntry, setEnabled, moveEntry, windowOpen, setWindowOpen };
}
