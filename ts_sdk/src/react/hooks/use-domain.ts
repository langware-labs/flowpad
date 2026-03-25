import { QueryRequest, TypeId, WebDomain } from '@sdk';
import { useMemo } from 'react';
import { useEntitiesQuery } from './entity-hooks';

export interface UseDomainResult {
  domain: WebDomain | undefined;
  domainTypeId: TypeId | undefined;
  domains: WebDomain[] | undefined;
  isLoading: boolean;
}

/**
 * Hook to fetch and manage WebDomain entities by domain name
 * @param hostname - The domain to search for (e.g., 'example.flowpad.app' or window.location.hostname)
 * @returns Object containing the matched domain, its typeId, all matching domains, and loading state
 */
export function useDomain(hostname?: string, scope: TypeId[] = []): UseDomainResult {
  const domainQueryRequest = useMemo(
    () =>
      new QueryRequest({
        type: WebDomain.type,
        query: hostname ? { domain: hostname } : null,
        scope,
        name: 'useDomain query',
      }),
    [hostname, scope],
  );

  const { data: domains, isLoading } = useEntitiesQuery<WebDomain>(domainQueryRequest);

  const domain = useMemo(() => {
    return domains?.length === 1 ? domains[0] : undefined;
  }, [domains]);

  const domainTypeId = useMemo(() => {
    return domain?.typeId;
  }, [domain]);

  return {
    domain,
    domainTypeId,
    domains,
    isLoading,
  };
}
