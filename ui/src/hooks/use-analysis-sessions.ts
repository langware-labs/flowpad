import { ProcessResult, QueryFilter, QueryRequest } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { useMemo } from 'react';

interface UseAnalysisSessionsOptions {
  limit?: number;
  autoFetch?: boolean;
}

export function useAnalysisSessions(options: UseAnalysisSessionsOptions = {}) {
  const limit = options.limit ?? 50;
  const queryRequest = useMemo(
    () =>
      new QueryRequest({
        type: ProcessResult.type,
        query: new QueryFilter({ limit, match: { result_type: 'analysis' } as Record<string, unknown> }),
        name: 'useAnalysisResults',
      }),
    [limit],
  );

  const {
    data = [],
    isLoading,
    error,
    refetch,
  } = useEntitiesQuery<ProcessResult>(queryRequest, {
    enabled: options.autoFetch !== false,
  });

  const items = useMemo(() => data.filter((item) => item.result_type === 'analysis'), [data]);

  return {
    items,
    isLoading,
    error,
    refresh: refetch,
  };
}
