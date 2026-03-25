import { QueryFilter, QueryRequest, TypeId, WatchQueryMap } from '@sdk'; // Adjust the import path accordingly
import { v4 as uuidv4 } from 'uuid';
import { describe, expect, it, vi } from 'vitest';

describe('WatchQueryMap', () => {
  it('should register a watch callback and retrieve it by type', () => {
    const queryMap = new WatchQueryMap<any>();
    const callback = vi.fn();
    const type = 'type1';
    const query: QueryFilter = QueryFilter.parse({ filterKey: 'key1' }, type);
    const scope: TypeId[] = [new TypeId(type, uuidv4())];

    const request = new QueryRequest({
      type,
      query,
      scope,
      callback,
    });
    queryMap.registerWatch(request, []);

    const watchedQueries = queryMap.getWatchCallbacksByType(type);

    expect(watchedQueries).toHaveLength(1);
    const watchedQuery = watchedQueries[0];
    expect(watchedQuery.getCallbacks()).toHaveLength(1);
    expect(watchedQuery.getCallbacks().has(callback)).toBeTruthy();
    expect(watchedQuery.request.query).toEqual(query);
    expect(watchedQuery.request.query instanceof QueryFilter).toBeTruthy();
    expect(watchedQuery.request.scope).toEqual(scope);
    expect(watchedQuery.request.scope[0] instanceof TypeId).toBeTruthy();
  });

  it('should retrieve watch callbacks by type and query', () => {
    const queryMap = new WatchQueryMap<any>();
    const callback = vi.fn();
    const type = 'type1';
    const query: QueryFilter = QueryFilter.parse({ filterKey: 'key1' }, type);
    const scope: TypeId[] = [new TypeId(type, uuidv4())];

    const request = new QueryRequest({ type, query, scope, callback });
    queryMap.registerWatch(request, []);

    const watchedQueries = queryMap.getWatchCallbacksByTypeAndQuery(type, query);

    expect(watchedQueries).toHaveLength(1);
    const watchedQuery = watchedQueries[0];
    expect(watchedQuery.getCallbacks()).toHaveLength(1);
    expect(watchedQuery.getCallbacks().has(callback)).toBeTruthy();
    expect(watchedQuery.results).toEqual([]);
    expect(watchedQuery.request.scope).toEqual(scope);
  });

  it('should retrieve watch callbacks by type, query, and scope', () => {
    const queryMap = new WatchQueryMap<any>();
    const callback = vi.fn();
    const type = 'type1';
    const query: QueryFilter = QueryFilter.parse({ filterKey: 'key1' }, type);
    const scope: TypeId[] = [new TypeId(type, uuidv4())];

    const request = new QueryRequest({ type, query, scope, callback });
    queryMap.registerWatch(request, []);

    const watchedQuery = queryMap.getWatchedQuery(request);
    const callbacks = watchedQuery?.getCallbacks();
    const results = watchedQuery?.results;

    expect(callbacks).toHaveLength(1);
    expect(callbacks).toBeDefined();
    expect(callbacks!.has(callback)).toBeTruthy();
    expect(results).toEqual([]);
  });

  it('should return empty array when no callbacks exist for a given type', () => {
    const queryMap = new WatchQueryMap<any>();

    const callbacks = queryMap.getWatchCallbacksByType('nonexistent_type');

    expect(callbacks).toHaveLength(0);
  });

  it('should return empty array when no callbacks exist for a given type and query', () => {
    const queryMap = new WatchQueryMap<any>();
    const type = 'type1';
    const query: QueryFilter = QueryFilter.parse({ filterKey: 'key1' }, type);

    const watchedQueries = queryMap.getWatchCallbacksByTypeAndQuery(type, query);

    expect(watchedQueries).toHaveLength(0);
  });

  it('should return empty array when no callbacks exist for a given type, query, and scope', () => {
    const queryMap = new WatchQueryMap<any>();
    const type = 'type1';
    const query: QueryFilter = QueryFilter.parse({ filterKey: 'key1' }, type);
    const scope: TypeId[] = [new TypeId(type, uuidv4())];

    const request = new QueryRequest({ type, query, scope });
    const watchedQuery = queryMap.getWatchedQuery(request);

    expect(watchedQuery).toBeUndefined();
  });

  it('should allow registering multiple callbacks for the same type, query, and scope', () => {
    const queryMap = new WatchQueryMap<any>();
    const callback1 = vi.fn();
    const callback2 = vi.fn();
    const type = 'type1';
    const query: QueryFilter = QueryFilter.parse({ filterKey: 'key1' }, type);
    const scope: TypeId[] = [new TypeId(type, uuidv4())];

    const request1 = new QueryRequest({ type, query, scope, callback: callback1 });
    queryMap.registerWatch(request1, []);
    const request2 = new QueryRequest({ type, query, scope, callback: callback2 });
    queryMap.registerWatch(request2, []);

    const watchedQuery = queryMap.getWatchedQuery(request1);
    const callbacks = watchedQuery?.getCallbacks();
    const results = watchedQuery?.results;

    expect(callbacks).toHaveLength(2);
    expect(callbacks!.has(callback1)).toBeTruthy();
    expect(callbacks!.has(callback2)).toBeTruthy();
    expect(results).toEqual([]);
  });

  it('should register and call a callback', async () => {
    const queryMap = new WatchQueryMap<any>();
    const callback = vi.fn();
    const type = 'type1';
    const query: QueryFilter = QueryFilter.parse({ filterKey: 'key1' }, type);
    const scope: TypeId[] = [new TypeId(type, uuidv4()), new TypeId(type, uuidv4())];

    // Register a callback
    const request = new QueryRequest({ type, query, scope, callback });
    queryMap.registerWatch(request, []);

    // Retrieve the callback
    const watchedQuery = queryMap.getWatchedQuery(request);
    const callbacks = watchedQuery?.getCallbacks();
    const results = watchedQuery?.results;

    expect(callbacks).toHaveLength(1);
    expect(callbacks!.has(callback)).toBeTruthy();
    expect(results).toEqual([]);

    // Call the callback with data
    for (const cb of callbacks!) {
      await cb([{ id: 'entity1' }]);
      break;
    }
    expect(callback).toHaveBeenCalledWith([{ id: 'entity1' }]);
  });

  it('should not register the same callback twice', () => {
    const queryMap = new WatchQueryMap<any>();
    const callback = vi.fn();
    const type = 'type1';
    const query: QueryFilter = QueryFilter.parse({ filterKey: 'key1' }, type);
    const scope: TypeId[] = [new TypeId(type, uuidv4()), new TypeId(type, uuidv4())];

    // Register the same callback twice
    const request1 = new QueryRequest({ type, query, scope, callback });
    queryMap.registerWatch(request1, []);
    const request2 = new QueryRequest({ type, query, scope, callback });
    queryMap.registerWatch(request2, []);

    // Retrieve the callbacks
    const watchedQuery = queryMap.getWatchedQuery(request1);
    const callbacks = watchedQuery?.getCallbacks();
    const results = watchedQuery?.results;

    // Should only have one callback
    expect(callbacks).toHaveLength(1);
    expect(results).toEqual([]);
  });

  it('should return a function to remove a registered callback', () => {
    const queryMap = new WatchQueryMap<any>();
    const callback = vi.fn();
    const type = 'type1';
    const query: QueryFilter = QueryFilter.parse({ filterKey: 'key1' }, type);
    const scope: TypeId[] = [new TypeId(type, uuidv4()), new TypeId(type, uuidv4())];

    // Register the callback and get the removal function
    const request = new QueryRequest({ type, query, scope, callback });
    const removeCallback = queryMap.registerWatch(request, []);

    // Check that the callback is registered
    let watchedQuery = queryMap.getWatchedQuery(request);
    expect(watchedQuery?.getCallbacks()).toHaveLength(1);
    expect(watchedQuery?.getCallbacks().has(callback)).toBeTruthy();
    expect(watchedQuery?.results).toEqual([]);

    // Call the removal function
    removeCallback();

    // Check that the callback is removed
    watchedQuery = queryMap.getWatchedQuery(request);
    expect(watchedQuery).toBeUndefined();
  });

  it('should clean up the maps when all callbacks are removed', () => {
    const queryMap = new WatchQueryMap<any>();
    const callback1 = vi.fn();
    const callback2 = vi.fn();
    const type = 'type1';
    const query: QueryFilter = QueryFilter.parse({ filterKey: 'key1' }, type);
    const scope: TypeId[] = [new TypeId(type, uuidv4()), new TypeId(type, uuidv4())];

    // Register two callbacks
    const request1 = new QueryRequest({ type, query, scope, callback: callback1 });
    const removeCallback1 = queryMap.registerWatch(request1, []);
    const request2 = new QueryRequest({ type, query, scope, callback: callback2 });
    const removeCallback2 = queryMap.registerWatch(request2, []);

    // Remove the first callback
    removeCallback1();

    // Check that the second callback is still registered
    let watchedQuery = queryMap.getWatchedQuery(request1);
    expect(watchedQuery?.getCallbacks()).toHaveLength(1);
    expect(watchedQuery?.getCallbacks().has(callback2)).toBeTruthy();
    expect(watchedQuery?.results).toEqual([]);

    // Remove the second callback
    removeCallback2();

    // Check that no callbacks are registered anymore
    watchedQuery = queryMap.getWatchedQuery(request1);
    expect(watchedQuery).toBeUndefined();

    // Verify that the internal maps are cleaned up
    const typeCallbacks = queryMap.getWatchCallbacksByType(type);
    expect(typeCallbacks).toHaveLength(0);
  });

  it('should handle different queries and scopes independently', () => {
    const queryMap = new WatchQueryMap<any>();
    const callback1 = vi.fn();
    const callback2 = vi.fn();
    const type = 'type1';
    const query1: QueryFilter = QueryFilter.parse({ filterKey: 'key1' }, type);
    const query2: QueryFilter = QueryFilter.parse({ filterKey: 'key2' }, type);
    const scope1: TypeId[] = [new TypeId(type, uuidv4())];
    const scope2: TypeId[] = [new TypeId(type, uuidv4())];

    // Register callbacks for different queries and scopes
    const request1 = new QueryRequest({ type, query: query1, scope: scope1, callback: callback1 });
    queryMap.registerWatch(request1, []);
    const request2 = new QueryRequest({ type, query: query2, scope: scope2, callback: callback2 });
    queryMap.registerWatch(request2, []);

    // Retrieve the callbacks for query1 and scope1
    const watchedQuery1 = queryMap.getWatchedQuery(request1);
    expect(watchedQuery1?.getCallbacks()).toHaveLength(1);
    expect(watchedQuery1?.getCallbacks().has(callback1)).toBeTruthy();
    expect(watchedQuery1?.results).toEqual([]);

    // Retrieve the callbacks for query2 and scope2
    const watchedQuery2 = queryMap.getWatchedQuery(request2);
    expect(watchedQuery2?.getCallbacks()).toHaveLength(1);
    expect(watchedQuery2?.getCallbacks().has(callback2)).toBeTruthy();
    expect(watchedQuery2?.results).toEqual([]);
  });

  it('test expand parse', () => {
    const queryJson = {
      filter: { match: { op: '$IN', operands: ['page', 'blah'] } },
      expand: 'permissions,auth_scopes',
    };
    const query = QueryFilter.parse(queryJson, 'page');
    expect(query.expand).toEqual(['permissions', 'auth_scopes']);
    const queryJson2 = { expand: 'permissions,auth_scopes' };
    const query2 = QueryFilter.parse(queryJson2, 'page');
    expect(query2.expand).toEqual(['permissions', 'auth_scopes']);
  });
});
