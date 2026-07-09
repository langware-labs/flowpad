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
//
// Uniqueness is load-bearing: two files that mint the SAME skill name share ONE
// on-disk folder (~/.claude/skills/<name>/), and the backend's `POST /graph/skill`
// is not idempotent by folder path — a second create for an existing folder mints
// a DUPLICATE entity that neither file's registry tracks, so it survives teardown
// and reds the leak detector.
//
// `Date.now()` ALONE is insufficient: the forks pool (vitest `pool: 'forks'`)
// pre-warms every child at once, so all setup modules evaluate within the SAME
// millisecond and every fork gets an identical `Date.now()`. Mix in the pid (unique
// per fork) plus a random suffix so the run id is unique even under simultaneous
// same-ms warmup.
const _pid = typeof process !== 'undefined' && process.pid ? process.pid : 0;
const RUN_ID = `${Date.now().toString(36)}${_pid.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
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

type Row = { name?: string; title?: string; nodeName?: string; id?: string };

/** Display label a type exposes (skill→name, conversation→title, agentic_process→nodeName). */
function labelOf(r: Row): string {
  if (typeof r?.name === 'string') return r.name;
  if (typeof r?.title === 'string') return r.title;
  if (typeof r?.nodeName === 'string') return r.nodeName;
  return '';
}

/** List a graph type; [] on any hiccup (never fails the caller on the lookup itself). */
async function listType(sdk: SdkLike, type: string): Promise<Row[]> {
  try {
    const data = (await sdk.apiClient.get(`${sdk.GRAPH_API_PREFIX}/${type}`)) as unknown;
    return (Array.isArray(data) ? data : ((data as { data?: unknown[] })?.data as Row[])) ?? [];
  } catch {
    return [];
  }
}

/** The set of types the sweep must cover: tracked ∪ declared sweep ∪ extras. */
function sweepTypeSet(extraTypes: string[] = []): Set<string> {
  return new Set<string>([...extraTypes, ..._trackedTypes, ..._sweepTypes]);
}

/** True iff a label is a test entity minted by THIS file's `testEntityName` (carries our RUN_ID). */
function isOurRunEntity(label: string): boolean {
  return label.startsWith(TEST_ENTITY_PREFIX) && label.includes(RUN_ID);
}

/**
 * Purge every backend entity minted by THIS file that survives after the tracked
 * purge — matched by name (this file's RUN_ID), not by the (now-drained)
 * registry. This is the real teardown net: it catches entities that were created
 * but never `trackForCleanup`'d AND rows the backend RE-MATERIALISED after the
 * tracked delete.
 *
 * Why re-materialisation happens: opening a skill/analysis in the app fires
 * `useEntityByPath` → `discoverByPath`, which kicks a single-type skill re-index.
 * If that walk read the skill folder BEFORE `afterEach` deleted the row+folder,
 * it finishes AFTER and `sync_to_db`'s the row back (same frontmatter id). The
 * per-test `purgeTracked` already ran and drained the registry, so nothing
 * re-deletes that row — it survives to the leak sweep. Scanning by RUN_ID (not
 * the registry) and purging in `afterAll` closes that window: the folder is gone,
 * so no further walk can re-create it once we delete this row.
 */
export async function purgeRunScoped(extraTypes: string[] = []): Promise<void> {
  const sdk = await loadSdk();
  if (!sdk) return;
  for (const type of sweepTypeSet(extraTypes)) {
    for (const r of await listType(sdk, type)) {
      if (isOurRunEntity(labelOf(r)) && r.id) {
        await purgeOne(sdk, type, r.id);
      }
    }
  }
}

/**
 * Leak detector: query the live backend and throw if any entity minted by THIS
 * file (test marker + this file's RUN_ID) survived teardown. Sweeps the union of
 * `extraTypes`, every type tracked this file, and declared tripwire types — so it
 * can't go blind to a type a hardcoded list forgot.
 *
 * Scoped to this file's RUN_ID on purpose: the backend is SHARED across the
 * per-file forks, so a neighbour file's in-flight or transient-residue entity
 * must never red — nor be deleted by — an unrelated file. A neighbour is the
 * single writer of its own entities; we only ever assert on / purge OUR run's.
 * A genuine un-purgeable leak of THIS file's entities (a delete that doesn't
 * stick, a product bug) still throws — so it is not a no-op.
 *
 * No-ops silently when no backend/realm is reachable (soft-skipped runs) — a
 * skip must never red the suite.
 */
export async function assertNoLeaks(extraTypes: string[] = []): Promise<void> {
  const sdk = await loadSdk();
  if (!sdk) return;
  const leaked: string[] = [];
  for (const type of sweepTypeSet(extraTypes)) {
    for (const r of await listType(sdk, type)) {
      if (isOurRunEntity(labelOf(r))) {
        leaked.push(`${type}:${labelOf(r)} (${r.id ?? '?'})`);
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
    // Sweep this file's residue by name (RUN_ID) — catches untracked creates AND
    // rows the backend re-materialised after the tracked delete (see
    // purgeRunScoped). Runs BEFORE the assert so the assert only fires on
    // genuinely un-purgeable leaks.
    await purgeRunScoped();
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
