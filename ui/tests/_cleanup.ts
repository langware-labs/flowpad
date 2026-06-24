/**
 * Shared test-cleanup registry + leak detector for tests that create REAL
 * entities against a LIVE local backend.
 *
 * Why this exists
 * ---------------
 * Live test tiers (headless / hub / hub-paired / react-stress) create real
 * Skills, Conversations, Workflows, etc. via the production SDK. Skills
 * materialise a folder under ~/.claude/skills/<name>/ and an entity row that
 * shows up in the app's asset picker. Without teardown those pile up forever
 * (this is how 51 `app-edit-skill-*` / `iso-skill-*` / `share-skill-*` /
 * `hub-test-skill-*` junk skills accumulated).
 *
 * Two facts shape the design:
 *  1. The plain `DELETE /api/v1/graph/<type>/<id>` removes only the DB row, NOT
 *     the on-disk `asset_ref` folder — and the skill indexer then RE-CREATES the
 *     row from the leftover folder on the next bootstrap/index. So a DB-only
 *     delete is self-undoing for skills.
 *  2. The fs-records route `DELETE /api/v1/graph/<ComputeNode>/@local/fs-records/<type>/<id>`
 *     is the FULL purge: entity row + FTS + the live `asset_ref` folder. The
 *     backend scopes the rmtree to the record's OWN asset_ref
 *     (`flow_sdk/builtin/faas/fs_records_actions.py` delete branch), so it is
 *     safe — it can only remove the folder that record points at. This is the
 *     same endpoint `tests/api/wiki.test.ts` already uses.
 *
 * So cleanup = the fs-records full purge (with a graph-delete fallback for
 * non-fs-records entity types). No node `fs` access, no managed-root guard in
 * the test layer — the backend owns the boundary.
 *
 * Realm correctness
 * -----------------
 * Headless/hub tests do `vi.resetModules()` + `await import('@sdk')` per test,
 * so the SDK singletons (apiClient/dataManager) are realm-bound and change per
 * test. We therefore grab the CURRENT realm lazily via `await import('@sdk')`
 * INSIDE the teardown hook — which runs after the just-finished test built its
 * realm and before the next test resets it — so apiClient carries the right
 * backend target + auth. For stable-realm tiers (api/react) the same lazy
 * import just returns the one realm. No realm handle is threaded through the
 * registry; we only store `{type,id}`.
 *
 * Usage
 * -----
 *   // in tests/<type>/_setup.ts (runs once per file):
 *   import { installCleanup } from '../_cleanup';
 *   installCleanup();                       // afterEach purge + afterAll leak sweep
 *
 *   // in a test:
 *   import { trackForCleanup, testEntityName } from '../_cleanup';
 *   const skill = trackForCleanup(await sdk.Skill.create(testEntityName('skill')));
 */

import { afterAll, afterEach } from 'vitest';

/**
 * Marker prefix for entities created by tests. The leak sweep keys off this, so
 * it is deliberately distinctive — real user skills are named things like
 * `test`, `shopper`, `rca`; none start with this. Migrate ad-hoc test names
 * (`app-edit-skill-…`, `iso-skill-…`, `pong-…`, `matrix-…`) to `testEntityName`.
 */
export const TEST_ENTITY_PREFIX = 'e2etest-';

// Per-process run id so concurrent/sequential files don't collide on names.
const RUN_ID = Date.now().toString(36);
let _seq = 0;

/** `e2etest-<kind>-<runId>-<seq>` — unique, sweep-identifiable test entity name. */
export function testEntityName(kind: string): string {
  _seq += 1;
  return `${TEST_ENTITY_PREFIX}${kind}-${RUN_ID}-${_seq}`;
}

type Trackable = { typeId: { type: string; id: string } };

const _registry: Array<{ type: string; id: string }> = [];
// Distinct entity types ever tracked this file. The leak sweep unions these so
// it can't go stale against what tests actually create — no per-tier list to
// hand-maintain. Never drained (purgeTracked only drains _registry).
const _trackedTypes = new Set<string>();
// Extra types to sweep even when nothing of that type was tracked — the genuine
// tripwire case (e.g. react sweeping agentic_process to catch an *un*-tracked
// create). Accumulated across install calls so a second install never silently
// drops its types.
const _sweepTypes = new Set<string>();

/** Record a created entity for teardown. Returns the entity for chaining. */
export function trackForCleanup<T extends Trackable>(entity: T): T {
  if (entity?.typeId?.type && entity?.typeId?.id) {
    _registry.push({ type: entity.typeId.type, id: entity.typeId.id });
    _trackedTypes.add(entity.typeId.type);
  }
  return entity;
}

/** Manually register a `{type,id}` (for entities reached via raw HTTP). */
export function trackTypeId(type: string, id: string): void {
  if (type && id) {
    _registry.push({ type, id });
    _trackedTypes.add(type);
  }
}

type SdkLike = {
  apiClient: { delete: (url: string) => Promise<unknown>; get: (url: string) => Promise<unknown> };
  GRAPH_API_PREFIX: string;
  ComputeNode: { type: string };
};

async function loadSdk(): Promise<SdkLike | null> {
  try {
    // Lazy: resolves the CURRENT realm (see "Realm correctness" above).
    return (await import('@sdk')) as unknown as SdkLike;
  } catch {
    return null;
  }
}

/**
 * Full-purge one entity: fs-records delete (removes row + FTS + asset_ref
 * folder) with a graph-delete fallback for entity types the fs-records route
 * doesn't register. Both failures are swallowed — the entity may already be
 * gone (deleted in-band, or a prior test). The leak sweep is the real gate.
 */
async function purgeOne(sdk: SdkLike, type: string, id: string): Promise<void> {
  const fsBase = `${sdk.GRAPH_API_PREFIX}/${sdk.ComputeNode.type}/@local/fs-records`;
  try {
    await sdk.apiClient.delete(`${fsBase}/${type}/${id}`);
    return;
  } catch {
    /* not an fs-records type, or already gone — fall back */
  }
  try {
    await sdk.apiClient.delete(`${sdk.GRAPH_API_PREFIX}/${type}/${id}`);
  } catch {
    /* best-effort */
  }
}

/** Purge everything currently tracked. Clears the registry. */
export async function purgeTracked(): Promise<void> {
  if (_registry.length === 0) return;
  const sdk = await loadSdk();
  const items = _registry.splice(0, _registry.length);
  if (!sdk) return; // no realm reachable (e.g. soft-skipped run) — nothing to purge
  for (const { type, id } of items) {
    await purgeOne(sdk, type, id);
  }
}

/**
 * Leak detector: query the live backend for any entity whose label carries the
 * test marker and throw if any survive. Sweeps the union of `extraTypes`, every
 * type actually tracked this file, and any declared tripwire types — so it
 * can't be blind to a type just because a hardcoded list wasn't updated.
 *
 * No-ops silently when no backend/realm is reachable (soft-skipped runs) — a
 * skip must never red the suite.
 */
export async function assertNoLeaks(extraTypes: string[] = []): Promise<void> {
  const sdk = await loadSdk();
  if (!sdk) return;
  const types = new Set<string>([...extraTypes, ..._trackedTypes, ..._sweepTypes]);
  const leaked: string[] = [];
  for (const type of types) {
    let rows: Array<{ name?: string; title?: string; nodeName?: string; id?: string }> = [];
    try {
      const data = (await sdk.apiClient.get(`${sdk.GRAPH_API_PREFIX}/${type}`)) as unknown;
      rows = Array.isArray(data) ? data : ((data as { data?: unknown[] })?.data as typeof rows) ?? [];
    } catch {
      continue; // type not listable / backend hiccup — don't fail on the detector itself
    }
    for (const r of rows) {
      // Types label their display field differently (skill→name,
      // conversation→title, agentic_process→nodeName).
      const label =
        typeof r?.name === 'string'
          ? r.name
          : typeof r?.title === 'string'
            ? r.title
            : typeof r?.nodeName === 'string'
              ? r.nodeName
              : '';
      if (label.startsWith(TEST_ENTITY_PREFIX)) {
        leaked.push(`${type}:${label} (${r.id ?? '?'})`);
      }
    }
  }
  if (leaked.length > 0) {
    throw new Error(
      `Test leftover detector FAILED — ${leaked.length} test entit${leaked.length === 1 ? 'y' : 'ies'} ` +
        `survived teardown:\n  ${leaked.join('\n  ')}\n` +
        `Every test-created entity must be trackForCleanup()'d so teardown purges it.`,
    );
  }
}

let _cleanupInstalled = false;
let _tripwireInstalled = false;

/**
 * Wire cleanup into the current test FILE (idempotent — hooks register once,
 * but every call's `sweepTypes` still accumulate, so a second install never
 * silently drops types). Call once from the tier's `_setup.ts`.
 *  - afterEach: purge everything tracked during that test (runs even if the
 *    test threw — guaranteed teardown on pass/fail).
 *  - afterAll: run the leak sweep and FAIL the file if any marked entity
 *    survived (catches creates that bypassed the registry).
 */
export function installCleanup(opts: { sweepTypes?: string[] } = {}): void {
  for (const t of opts.sweepTypes ?? ['skill']) _sweepTypes.add(t);
  if (_cleanupInstalled) return;
  _cleanupInstalled = true;

  afterEach(async () => {
    await purgeTracked();
  });

  afterAll(async () => {
    await purgeTracked(); // anything tracked at file scope (beforeAll creates)
    await assertNoLeaks();
  });
}

/**
 * Leak-sweep tripwire ONLY (no per-test purge) — for tiers that are mocked or
 * self-isolated (unit/api) and don't use the registry, but still want a guard
 * that fails the file if a test ever leaks a marked entity. `assertNoLeaks`
 * no-ops when no backend is reachable, so it's safe on mocked tiers.
 */
export function installLeakTripwire(types: string[] = ['skill']): void {
  for (const t of types) _sweepTypes.add(t);
  if (_tripwireInstalled) return;
  _tripwireInstalled = true;
  afterAll(async () => {
    await assertNoLeaks();
  });
}
