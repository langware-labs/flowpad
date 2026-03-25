import { useEffect, useState } from 'react';
import apiClient from '@sdk/client';

const STATUS_PATH = '/graph/compute_node/@local/fs-records/index-status';

export interface IndexStatus {
  never_indexed: boolean;
  last_indexed_at: string | null;
  stale: boolean;
  default_types: string[];
}

export type IndexStatusState =
  | { phase: 'loading' }
  | { phase: 'ready'; status: IndexStatus };

export function useIndexStatus(): IndexStatusState {
  const [state, setState] = useState<IndexStatusState>({ phase: 'loading' });

  useEffect(() => {
    apiClient
      .get(STATUS_PATH)
      .then((data: unknown) => {
        setState({ phase: 'ready', status: data as IndexStatus });
      })
      .catch(() => {
        // On error assume ok — don't block search
        setState({
          phase: 'ready',
          status: { never_indexed: false, last_indexed_at: null, stale: false, default_types: [] },
        });
      });
  }, []);

  return state;
}
