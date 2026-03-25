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
