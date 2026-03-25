import { TypeId } from '../models/TypeId';
import { QueryFilter, QueryRequest, WatchedQuery } from './query';

export class TypeIdMap<T> {
  private map: Map<string, T>;
  private originalKeys: Map<string, TypeId>;

  constructor() {
    this.map = new Map<string, T>();
    this.originalKeys = new Map<string, TypeId>();
  }

  // Set a value in the map
  set(key: TypeId, value: T) {
    const serializedKey = key.toString();
    this.map.set(serializedKey, value);
    this.originalKeys.set(serializedKey, key);
  }

  // Get a value from the map
  get(key: TypeId): T | undefined {
    const serializedKey = key.toString();
    return this.map.get(serializedKey);
  }

  // Check if a key exists in the map
  has(key: TypeId): boolean {
    const serializedKey = key.toString();
    return this.map.has(serializedKey);
  }

  // Delete a key from the map
  delete(key: TypeId) {
    const serializedKey = key.toString();
    this.map.delete(serializedKey);
    this.originalKeys.delete(serializedKey);
  }

  // Clear the map
  clear() {
    this.map.clear();
    this.originalKeys.clear();
  }

  // Get the size of the map
  get size() {
    return this.map.size;
  }

  // Get all keys in the map
  keys(): IterableIterator<TypeId> {
    return this.originalKeys.values();
  }

  // Get all values in the map
  values(): IterableIterator<T> {
    return this.map.values();
  }

  // Get all entries in the map
  entries(): IterableIterator<[TypeId, T]> {
    const entriesArray: [TypeId, T][] = [];
    for (const [serializedKey, value] of this.map.entries()) {
      const originalKey = this.originalKeys.get(serializedKey)!;
      entriesArray.push([originalKey, value]);
    }
    return entriesArray[Symbol.iterator]();
  }

  // Map over all entries
  forEach(callbackfn: (value: T, key: TypeId, map: TypeIdMap<T>) => void, thisArg?: any) {
    for (const [serializedKey, value] of this.map.entries()) {
      const originalKey = this.originalKeys.get(serializedKey)!;
      callbackfn.call(thisArg, value, originalKey, this);
    }
  }

  [Symbol.iterator](): IterableIterator<[TypeId, T]> {
    return this.entries();
  }
}

export class SubscriptionMap<T> extends TypeIdMap<Set<(entity: T | null) => void | Promise<void>>> {}
export class WatchMap extends TypeIdMap<number> {}

export class WatchQueryMap<T> {
  // Single flat Map: QueryRequest.key -> WatchedQuery
  private watchedQueries: Map<string, WatchedQuery<T>> = new Map();

  public registerWatch(request: QueryRequest, results?: T[], pendingPromise?: Promise<T[]>): () => void {
    if (!request.callback) {
      throw new Error('QueryRequest must have a callback for registerWatch');
    }

    const key = request.key;

    // Get or create WatchedQuery
    let watchedQuery = this.watchedQueries.get(key);
    if (!watchedQuery) {
      watchedQuery = new WatchedQuery<T>(request, results, pendingPromise);
      this.watchedQueries.set(key, watchedQuery);
    } else {
      // Add callback to existing watched query
      watchedQuery.addCallback(request.callback);
      // Update results if provided
      if (results && results !== watchedQuery.results) {
        watchedQuery.results = results;
      }
      // Update pending promise if provided
      if (pendingPromise) {
        watchedQuery.pendingPromise = pendingPromise;
      }
    }

    // Return unsubscribe function
    return () => {
      this.removeCallbackAndCleanup(key, request.callback!);
    };
  }

  public registerWatchResults(request: QueryRequest, results?: T[], pendingPromise?: Promise<T[]>): void {
    const key = request.key;

    let watchedQuery = this.watchedQueries.get(key);
    if (!watchedQuery) {
      watchedQuery = new WatchedQuery<T>(request, results, pendingPromise);
      this.watchedQueries.set(key, watchedQuery);
    } else {
      watchedQuery.results = results;
      // Update pending promise if provided
      if (pendingPromise) {
        watchedQuery.pendingPromise = pendingPromise;
      }
    }
  }

  public getWatchCallbacksByType(type: string): WatchedQuery<T>[] {
    const result: WatchedQuery<T>[] = [];

    // Iterate and filter by type
    for (const watchedQuery of this.watchedQueries.values()) {
      if (watchedQuery.request.type === type) {
        result.push(watchedQuery);
      }
    }

    return result;
  }

  public getWatchCallbacksByTypeAndQuery(type: string, query: QueryFilter | null): WatchedQuery<T>[] {
    const result: WatchedQuery<T>[] = [];

    // Iterate and filter by type and query
    for (const watchedQuery of this.watchedQueries.values()) {
      if (watchedQuery.request.type === type && watchedQuery.request.query === query) {
        result.push(watchedQuery);
      }
    }

    return result;
  }

  /**
   * Get the WatchedQuery object for a specific query request
   * Returns undefined if no watched query exists for this request
   */
  public getWatchedQuery(request: QueryRequest): WatchedQuery<T> | undefined {
    const key = request.key;
    return this.watchedQueries.get(key);
  }

  /**
   * @deprecated Use getWatchedQuery() instead and access properties directly
   * This method will be removed in a future version
   */
  public getWatchCallbacks(request: QueryRequest): {
    callbacks?: Set<(entities: T[]) => void | Promise<void>>;
    results?: T[];
  } {
    const watchedQuery = this.getWatchedQuery(request);
    if (!watchedQuery) return {};

    return {
      callbacks: watchedQuery.getCallbacks(),
      results: watchedQuery.results,
    };
  }

  /**
   * Update results for a specific query and notify all callbacks
   */
  public updateQueryResults(request: QueryRequest, results: T[]): void {
    // Use the request's key directly - no need to reconstruct
    const key = request.key;

    const watchedQuery = this.watchedQueries.get(key);
    if (!watchedQuery) return;

    watchedQuery.updateResults(results);
  }

  /**
   * Remove entity from query results and notify callbacks
   */
  public removeEntityFromResults(type: string, entityTypeId: TypeId): void {
    // Iterate and filter by type
    for (const watchedQuery of this.watchedQueries.values()) {
      if (watchedQuery.request.type === type && watchedQuery.results) {
        const beforeLength = watchedQuery.results.length;

        const index = watchedQuery.results.findIndex((entity: any) => entity.typeId.equals(entityTypeId));
        if (index !== -1) {
          watchedQuery.results.splice(index, 1);
          if (beforeLength !== watchedQuery.results.length) {
            watchedQuery.notifyCallbacks();
          }
        }
      }
    }
  }

  /**
   * Get all watched queries for debugging
   */
  public getAllWatchedQueries(): WatchedQuery<T>[] {
    return Array.from(this.watchedQueries.values());
  }

  /**
   * Remove callback and clean up empty structures
   */
  private removeCallbackAndCleanup(key: string, callback: (entities: T[]) => void | Promise<void>): void {
    const watchedQuery = this.watchedQueries.get(key);
    if (!watchedQuery) return;

    // Remove the callback
    watchedQuery.removeCallback(callback);

    // Clean up if no callbacks left
    if (!watchedQuery.hasCallbacks()) {
      this.watchedQueries.delete(key);
    }
  }
}
