# SDK and frontend integration review

Reviewed the current working tree on 2026-09-06, alongside the four delegated backend area reviews. The checkout contained unrelated edits and changed during inspection. The two findings below were reproduced against the actual implementation; temporary test files were removed afterward. No application changes were made.

## SDK1 — P2: a cold query watch registers twice and never fully unsubscribes

**Confirmed by an isolated Vitest probe using the real DataManager; only HTTP responses were stubbed.**

The cold path in [DataManager.watchQuery](/Users/shlom/Documents/dev/flowpad-oss/ts_sdk/src/FlowSync/store.ts:1532) calls `_query`, which creates the pending cache entry through `registerWatchResults`. The [WatchedQuery constructor](/Users/shlom/Documents/dev/flowpad-oss/ts_sdk/src/FlowSync/query.ts:334) registers the request callback. Once fetching finishes, [WatchQueryMap.registerWatch](/Users/shlom/Documents/dev/flowpad-oss/ts_sdk/src/FlowSync/map.ts:104) adds that same function again under a different callback name. `removeCallback` removes only its first match.

The probe performed one cold watch and then called its returned unsubscribe function:

```text
Expected: { registered: 1, remaining: 0 }
Actual:   { registered: 2, remaining: 1 }
```

This retains a consumer after it unsubscribes, duplicates callbacks while mounted, and keeps obsolete query results eligible for later invalidation/refetch. The retained consumer can reference old component state. The leak occurs without a race or a premature unmount.

**Fix seam:** separate cached query-result creation from subscription registration. Only `watchQuery` should add the caller's subscription, with a token that its unsubscribe removes exactly once. Preserve the shared pending request and entity cache. The React hook must also handle cleanup before async subscription setup finishes; the current concurrent working-tree edits already add a `disposed` guard there, so that separate hook issue is not reported as outstanding.

**Verification:** one cold watch has one callback; two consumers share one HTTP request and have two callbacks; each unsubscribe removes only its own callback; after both unsubscribe, no stale subscription remains. Repeat with StrictMode and cleanup during an in-flight request.

## SDK2 — P2: asset search lets an older response replace a newer query's results

**Confirmed by a real React hook test with deferred HTTP responses.**

[useAssetSearch](/Users/shlom/Documents/dev/flowpad-oss/ui/src/hooks/use-asset-search.ts:44) uses one shared `cancelledRef`. Cleanup sets it true, but the next effect resets it to false at line 57. A request from the old effect now passes the cancellation check at line 85 and overwrites results for the current query. The same issue affects errors from an old request.

The probe sent `older`, changed the query to `newer`, completed `newer`, then completed `older`:

```text
After newer completion: ["newer"]
After older completion: ["older"]    # should remain ["newer"]
```

The sibling [useRecordSearch](/Users/shlom/Documents/dev/flowpad-oss/ui/src/hooks/use-record-search.ts:124) already uses an effect-local cancellation flag. Its existing request-order regression passed in the same test invocation.

**Fix seam:** give each effect/request its own cancellation or generation token. Reuse a shared SDK search request implementation when consolidating the two server search APIs. Do not change debounce or timeout budgets.

**Verification:** older successes and errors cannot replace newer results, loading state, or errors. Cover changing query, type, page and scope while requests are pending.

## Related query ownership and code reduction

[useRecordSearch.applyTimeFilter](/Users/shlom/Documents/dev/flowpad-oss/ui/src/hooks/use-record-search.ts:87) filters only the already-limited result page, while `total` remains the server's unfiltered value. Time bounds are not sent in the request. A matching row outside that page cannot appear even if it satisfies the time filter. This is another instance of the backend search review's filter-before-pagination finding; it should be fixed in the same shared query service, not counted as a separate root cause.

Both search hooks own request construction, debouncing, result state and error handling, and they target different search routes. Keep their presentation-specific result adapters, but consolidate the query contract, lifecycle, and server-side filtering. The existing entity cache should remain the identity authority for hydrated entities; avoid adding another independently mutable copy of an entity.

The legacy `FsRecord` DTO layer also retains `raw_json`, record-edge fields and storage-layout metadata after the Python model removed those concepts. These are exported SDK surfaces, so removal needs a consumer audit; their mere presence is not proof that they are safely deletable.

## Validation

The unit tier points at an intentionally invalid backend hostname; HTTP responses for the probes were stubbed, and no running instance was contacted. Startup printed its existing invalid-host diagnostic. Both review assertions failed with the exact incorrect state above, while the existing `use-record-search-race.test.tsx` suite passed both tests. No timeouts were changed.

Temporary probes were removed from `ui/tests/unit` after execution. Copies are retained as supporting review material at `/Users/shlom/Documents/dev/flowpad-oss/reports/data-management-review-2026-09-06/evidence/flowpad-review-watch-leak.test.ts` and `/Users/shlom/Documents/dev/flowpad-oss/reports/data-management-review-2026-09-06/evidence/flowpad-review-search-race.test.tsx`. These results are targeted reproductions, not a complete UI or regression-suite assessment.
