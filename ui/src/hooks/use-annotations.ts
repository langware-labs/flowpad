import { Annotation, QueryRequest, TypeId } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { useMemo } from 'react';

/**
 * Hook to fetch all Annotation entities, optionally filtered client-side by target TypeId.
 *
 * Fetches all annotations in one unscoped query (same pattern as useProjectBookmarks).
 * When typeId is provided, only annotations matching target_type + target_id are returned.
 *
 * Reactivity: DataOpMessage via WebSocket triggers automatic re-fetch when annotations change.
 */

const QUERY_REQUEST = new QueryRequest({ type: 'annotation', scope: [], name: 'useAnnotations' });

export function useAnnotations(typeId: TypeId | null | undefined) {
  const { data: all = [], isLoading, error, refetch } = useEntitiesQuery<Annotation>(QUERY_REQUEST);

  const annotations = useMemo(
    () =>
      typeId
        ? all.filter((a) => a.target_type === typeId.type && a.target_id === typeId.id)
        : all,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [all, typeId?.type, typeId?.id],
  );

  return { annotations, isLoading, error, refetch };
}
