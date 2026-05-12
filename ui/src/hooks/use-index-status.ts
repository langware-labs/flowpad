import { useCallback, useEffect, useState } from 'react';
import apiClient from '@sdk/client';

const STATUS_PATH = '/graph/compute_node/@local/fs-records/index-status';

export interface IndexStatus {
  never_indexed: boolean;
  last_indexed_at: string | null;
  stale: boolean;
  default_types: string[];
  per_type?: Array<{
    type_name: string;
    last_indexed_at: string | null;
    entity_count: number;
    stale: boolean;
  }>;
}

export type IndexStatusState =
  | { phase: 'loading' }
  | { phase: 'ready'; status: IndexStatus };

export interface UseIndexStatusResult {
  state: IndexStatusState;
  refresh: () => void;
}

const EMPTY_STATUS: IndexStatus = {
  never_indexed: false,
  last_indexed_at: null,
  stale: false,
  default_types: [],
};

export function useIndexStatus(): UseIndexStatusResult {
  const [state, setState] = useState<IndexStatusState>({ phase: 'loading' });

  const refresh = useCallback(() => {
    apiClient
      .get(STATUS_PATH)
      .then((data: unknown) => {
        setState({ phase: 'ready', status: data as IndexStatus });
      })
      .catch(() => {
        // On error assume ok — don't block search
        setState({ phase: 'ready', status: EMPTY_STATUS });
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { state, refresh };
}
