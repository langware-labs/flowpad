import { TypeId } from '@sdk';
import { useCallback } from 'react';
import { useChatOptions } from './useChatOptions';

export interface UseEntityLabelsReturn {
  labels: string[];
  addLabel: (label: string) => void;
  removeLabel: (label: string) => void;
  hasLabel: (label: string) => boolean;
  setLabels: (labels: string[]) => void;
}

/**
 * Hook for managing labels via useChatOptions
 * @param processTypeId - The process TypeId (optional)
 * @returns Label management functions that sync through useChatOptions
 */
export function useEntityLabels(processTypeId: TypeId | null | undefined): UseEntityLabelsReturn {
  const { values, onChange } = useChatOptions(processTypeId);

  const labels = values.labels;

  const hasLabel = useCallback(
    (label: string) => {
      return labels.includes(label);
    },
    [labels],
  );

  const addLabel = useCallback(
    (label: string) => {
      if (labels.includes(label)) return;
      const newLabels = [label, ...labels];
      onChange({ ...values, labels: newLabels });
    },
    [labels, values, onChange],
  );

  const removeLabel = useCallback(
    (label: string) => {
      const newLabels = labels.filter((l) => l !== label);
      onChange({ ...values, labels: newLabels });
    },
    [labels, values, onChange],
  );

  const setLabels = useCallback(
    (newLabels: string[]) => {
      onChange({ ...values, labels: newLabels });
    },
    [values, onChange],
  );

  return {
    labels,
    addLabel,
    removeLabel,
    hasLabel,
    setLabels,
  };
}
