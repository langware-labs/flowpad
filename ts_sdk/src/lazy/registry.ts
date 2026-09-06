import { hashKey, type QueryClient, type FetchQueryOptions } from '@tanstack/query-core';
import { assetDefinitions, type AssetData, type AssetParams } from './assets';
import type { AssetDefinition } from './definition';
import { LazyAsset } from './LazyAsset';
import { queryClient } from './queryClient';

type RegisteredAssets = { [A in LazyAsset]: AssetDefinition<AssetParams<A>, AssetData<A>> };

type Args<A extends LazyAsset> = undefined extends AssetParams<A> ? [params?: AssetParams<A>] : [params: AssetParams<A>];

export class LazyAssetRegistry {
  private scope = 'initial';
  private generation = 0;
  private controller = new AbortController();
  private listeners = new Set<() => void>();
  private subscriptions = new Map<string, () => void>();
  private queuedInvalidations = new Map<string, Promise<void>>();

  constructor(readonly client: QueryClient, private readonly definitions: RegisteredAssets = assetDefinitions) {
    client.getQueryCache().subscribe(event => {
      if (event.type === 'removed') {
        this.subscriptions.get(event.query.queryHash)?.();
        this.subscriptions.delete(event.query.queryHash);
      }
    });
  }

  getScope = () => this.scope;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Authentication/instance boundary: cancel old reads and discard late results. */
  setScope(scope: string): void {
    if (scope === this.scope) return;
    this.scope = scope;
    this.generation++;
    this.controller.abort();
    this.controller = new AbortController();
    this.queuedInvalidations.clear();
    this.client.removeQueries({ queryKey: ['lazy'] });
    for (const listener of this.listeners) listener();
  }

  prefix(asset: LazyAsset) { return ['lazy', asset] as const; }

  key<A extends LazyAsset>(asset: A, params?: AssetParams<A>) {
    const definition: AssetDefinition<AssetParams<A>, AssetData<A>> = this.definitions[asset];
    return [...this.prefix(asset), this.scope, definition.key ? definition.key(params as AssetParams<A>) : params ?? null] as const;
  }

  options<A extends LazyAsset>(asset: A, params?: AssetParams<A>): FetchQueryOptions<AssetData<A>> {
    const definition: AssetDefinition<AssetParams<A>, AssetData<A>> = this.definitions[asset];
    const queryKey = this.key(asset, params);
    const queryHash = hashKey(queryKey);
    const generation = this.generation;
    const isCurrent = () => generation === this.generation;
    const signal = this.controller.signal;
    return {
      queryKey,
      staleTime: definition.staleTime ?? 5 * 60 * 1000,
      retry: false,
      structuralSharing: false, // SDK entities are canonical mutable instances.
      queryFn: async (): Promise<AssetData<A>> => {
        performance.mark?.(`lazy:${asset}:start`);
        try {
          if (!isCurrent()) throw new Error('SDK scope changed');
          let data: AssetData<A> = await definition.load(params as AssetParams<A>, { signal, isCurrent });
          if (!isCurrent()) throw new Error('SDK scope changed');
          if (definition.subscribe && !this.subscriptions.has(queryHash)) {
            this.subscriptions.set(queryHash, () => {});
            const unsubscribe = await definition.subscribe(params as AssetParams<A>, value => {
              if (isCurrent() && this.subscriptions.has(queryHash)) {
                data = value;
                this.client.setQueryData(queryKey, value);
              }
            }, data);
            if (isCurrent() && this.subscriptions.has(queryHash)) this.subscriptions.set(queryHash, unsubscribe);
            else unsubscribe();
          }
          return data;
        } catch (error) {
          this.subscriptions.get(queryHash)?.();
          this.subscriptions.delete(queryHash);
          throw error;
        } finally {
          performance.mark?.(`lazy:${asset}:settled`);
        }
      },
    };
  }

  load<A extends LazyAsset>(asset: A, ...[params]: Args<A>): Promise<AssetData<A>> {
    return this.client.fetchQuery(this.options(asset, params));
  }

  prefetch<A extends LazyAsset>(asset: A, ...[params]: Args<A>): Promise<void> {
    return this.client.prefetchQuery(this.options(asset, params));
  }

  async refresh<A extends LazyAsset>(asset: A, params?: AssetParams<A>): Promise<AssetData<A>> {
    // Join an existing request, including one needed by another component.
    await this.client.invalidateQueries({ queryKey: this.key(asset, params), exact: true, refetchType: 'none' });
    return this.client.fetchQuery(this.options(asset, params));
  }

  async invalidate<A extends LazyAsset>(asset: A, params?: AssetParams<A>): Promise<void> {
    const queries = this.client.getQueryCache().findAll({ queryKey: params === undefined ? this.prefix(asset) : this.key(asset, params), exact: params !== undefined });
    await Promise.all(queries.map(query => {
      const invalidate = () => this.client.invalidateQueries({ queryKey: query.queryKey, exact: true }, { cancelRefetch: false });
      if (!query.promise || query.state.fetchStatus !== 'fetching') return invalidate();
      // An event may arrive after the server took its snapshot. Keep that shared
      // read alive, then invalidate once; an unobserved entry simply stays stale.
      const queued = this.queuedInvalidations.get(query.queryHash);
      if (queued) return queued;
      const generation = this.generation;
      const next = query.promise.catch(() => {}).then(() => {
        if (generation !== this.generation) return;
        this.queuedInvalidations.delete(query.queryHash);
        return invalidate();
      });
      this.queuedInvalidations.set(query.queryHash, next);
      return next;
    }));
  }
}

export const lazyAssets = new LazyAssetRegistry(queryClient);
