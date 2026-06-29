import { APIEntity, ApiError, ExpansionRequest } from '@sdk';

export type useEntityOptions<T extends APIEntity<T>> = {
  watch?: boolean;
  query?: ExpansionRequest;
  enabled?: boolean;
  staleTime?: number;
  refetchInterval?: number;
  initialData?: T | null;
};

export interface UseEntityResult<T> {
  data: T | null | undefined;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  error: ApiError | null;
  isSuccess: boolean;
  /**
   * True when the backend 404'd this typeId — the entity has no local row.
   * Distinct from a transient error (``isError``): a not-found result is
   * terminal and won't re-fetch, so consumers can render an "unavailable"
   * state instead of looping. A later materialization (WS / cache invalidate)
   * clears it and re-renders with real data.
   */
  notFound: boolean;
  refetch: () => Promise<void>;
}

export interface UseEntitiesQueryResult<T> {
  data: T[] | undefined;
  isLoading: boolean;
  error: ApiError | null;
  isError: boolean;
  isSuccess: boolean;
  refetch: () => Promise<void>;
}
