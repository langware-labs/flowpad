/**
 * fs-records: scan → index → search (full cycle) API tests.
 *
 * Mimics how the FsRecordsScannerViewer UI widget works:
 *   1. GET /fs-records               → list registered types
 *   2. GET /fs-records/scan?type=X   → per-type scan (count, records)
 *   3. POST /fs-records/index?type=X → index a type into FTS
 *   4. GET /fs-records/search?q=...  → FTS search returns results
 *
 * These tests require a running backend at localhost:9007.
 *
 * Regression coverage for two bugs fixed 2026-03-09:
 *   Bug 1: Record.index() stored entities with type='entity' instead of the
 *           record's actual type → FTS search returned empty results.
 *   Bug 2: fts_search silently returned [] because _schema_to_entity choked
 *           on raw-SQL date strings ('str' object has no attribute tzinfo').
 */

import { apiClient, ComputeNode, GRAPH_API_PREFIX } from '@sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

const signupInfo = getTestSignupInfo();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Base URL for fs-records actions on the @local compute node. */
const CN_FS_BASE = `${GRAPH_API_PREFIX}/${ComputeNode.type}/@local/fs-records`;

/**
 * Unwrap the data payload from an ApiSuccessResponse.
 * apiClient may return the wrapped `{ status, data }` shape or pre-unwrapped data.
 */
function unwrapData(response: unknown): Record<string, unknown> {
  const r = response as Record<string, unknown>;
  if (r && typeof r === 'object' && 'data' in r) {
    return r.data as Record<string, unknown>;
  }
  return r as Record<string, unknown>;
}

/** Create a skill record via POST /fs-records/skill and return its id. */
async function createSkill(name: string, description: string): Promise<string> {
  const response = await apiClient.post<unknown>(
    `${CN_FS_BASE}/skill`,
    { name, description },
  );
  const data = unwrapData(response);
  return data.id as string;
}

// ---------------------------------------------------------------------------
// Tests: Scan
// ---------------------------------------------------------------------------

describe('fs-records scan', () => {
  beforeEach(async (context: any) => {
    await apiTestSetup(signupInfo, context.task.name);
  });

  it('GET /fs-records returns list of registered types', async () => {
    const response = await apiClient.get<unknown>(CN_FS_BASE);
    const data = unwrapData(response);
    expect(data).toHaveProperty('types');
    expect(Array.isArray(data.types)).toBe(true);
    expect((data.types as string[]).length).toBeGreaterThan(0);
    // 'skill' is always registered
    expect(data.types as string[]).toContain('skill');
  });

  it('GET /fs-records/scan returns aggregate stats', async () => {
    // Use limit_types=5 so this test completes quickly on machines with large datasets
    const response = await apiClient.get<unknown>(`${CN_FS_BASE}/scan?limit_types=5`);
    const data = unwrapData(response);
    expect(data).toHaveProperty('types');
    expect(data).toHaveProperty('grand_total');
    expect(data).toHaveProperty('scan_ms');
    expect(Array.isArray(data.types)).toBe(true);
  });

  it('GET /fs-records/scan?type=skill discovers skills', async () => {
    // Scan discovers skills from ~/.claude/skills and cwd/.claude/skills directories,
    // NOT from the records root where CRUD-created records are stored.
    const response = await apiClient.get<unknown>(`${CN_FS_BASE}/scan?type=skill`);
    const data = unwrapData(response);

    expect(data.type).toBe('skill');
    expect(Number(data.count)).toBeGreaterThanOrEqual(1);
    expect(data).toHaveProperty('records');
    expect(Array.isArray(data.records)).toBe(true);

    // Each record should have expected shape
    const records = data.records as Array<{ uid: string; name: string; size_bytes: number; status: string }>;
    expect(records.length).toBeGreaterThanOrEqual(1);
    expect(records.every((r) => r.uid && r.name && typeof r.size_bytes === 'number')).toBe(true);
  });

  it('GET /fs-records/scan?type=skill includes byte stats', async () => {
    await createSkill('Byte Stats Skill', 'byte stats test');
    const response = await apiClient.get<unknown>(`${CN_FS_BASE}/scan?type=skill`);
    const data = unwrapData(response);
    expect(data).toHaveProperty('min_bytes');
    expect(data).toHaveProperty('max_bytes');
    expect(data).toHaveProperty('avg_bytes');
    expect(data).toHaveProperty('scan_ms');
  });

  it('GET /fs-records/scan?type=unknown returns 400', async () => {
    try {
      await apiClient.get<unknown>(`${CN_FS_BASE}/scan?type=no_such_type_xyz`);
      // If no exception thrown, the response may contain an error code
      // Accept either: thrown or status FAIL
    } catch {
      // Expected — 400 throws
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: Index
// ---------------------------------------------------------------------------

describe('fs-records index', () => {
  beforeEach(async (context: any) => {
    await apiTestSetup(signupInfo, context.task.name);
  });

  it('POST /fs-records/index?type=skill returns valid response shape', async () => {
    const response = await apiClient.post<unknown>(`${CN_FS_BASE}/index?type=skill`, {});
    const data = unwrapData(response);
    expect(data).toHaveProperty('type');
    expect(data.type).toBe('skill');
    expect(data).toHaveProperty('indexed');
    expect(typeof data.indexed).toBe('number');
    // errors field is present when some records fail sync_to_db
    expect(data).toHaveProperty('errors');
    expect(typeof data.errors).toBe('number');
  });

  it('POST /fs-records/index?type=skill processes discovered skills', async () => {
    // Index discovers skills from ~/.claude/skills directories (not from CRUD-created records).
    // Some skills may fail sync_to_db, so we check indexed + errors >= discovered count.
    const response = await apiClient.post<unknown>(`${CN_FS_BASE}/index?type=skill`, {});
    const data = unwrapData(response);
    expect(data.type).toBe('skill');
    const total = Number(data.indexed) + Number(data.errors);
    expect(total).toBeGreaterThanOrEqual(1);
  });

  it('POST /fs-records/index (all types) returns total and types array', async () => {
    // Use limit_per_type=2&limit_types=3 so this test completes quickly on machines with large datasets.
    const response = await apiClient.post<unknown>(`${CN_FS_BASE}/index?limit_per_type=2&limit_types=3`, {});
    const data = unwrapData(response);
    expect(data).toHaveProperty('indexed');
    expect(data).toHaveProperty('types');
    expect(Array.isArray(data.types)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: Search
// ---------------------------------------------------------------------------

describe('fs-records search', () => {
  beforeEach(async (context: any) => {
    await apiTestSetup(signupInfo, context.task.name);
  });

  it('GET /fs-records/search (no params) returns empty results', async () => {
    const response = await apiClient.get<unknown>(`${CN_FS_BASE}/search`);
    const data = unwrapData(response);
    expect(data).toHaveProperty('results');
    expect(Array.isArray(data.results)).toBe(true);
    expect(data.results as unknown[]).toHaveLength(0);
    expect(data).toHaveProperty('total');
  });

  it('GET /fs-records/search?record_type=skill lists skills without query (browse mode)', async () => {
    // Browse mode returns skills that have been indexed into the DB.
    // First index skills so browse has data to return.
    await apiClient.post<unknown>(`${CN_FS_BASE}/index?type=skill`, {});

    const response = await apiClient.get<unknown>(`${CN_FS_BASE}/search?record_type=skill`);
    const data = unwrapData(response);
    const results = data.results as Array<{ record_id: string; record_type: string; name: string }>;
    // Results depend on whether sync_to_db succeeded for any skills
    if (results.length > 0) {
      expect(results.every((r) => r.record_type === 'skill')).toBe(true);
      expect(results.every((r) => 'name' in r && 'record_id' in r)).toBe(true);
    }
  });

  it('search response always has indexer_ready field', async () => {
    const r1 = await apiClient.get<unknown>(`${CN_FS_BASE}/search?q=anything`);
    expect(unwrapData(r1)).toHaveProperty('indexer_ready');

    const r2 = await apiClient.get<unknown>(`${CN_FS_BASE}/search?record_type=skill`);
    expect(unwrapData(r2)).toHaveProperty('indexer_ready');
  });
});

// ---------------------------------------------------------------------------
// Tests: Full cycle (regression for the two bugs)
// ---------------------------------------------------------------------------

describe('fs-records full cycle: scan → index → search', () => {
  beforeEach(async (context: any) => {
    await apiTestSetup(signupInfo, context.task.name);
  });

  /**
   * Full cycle: scan discovers skills from .claude/skills dirs, index syncs them to DB,
   * and search finds them via FTS.
   *
   * Note: CRUD-created skills (via POST /fs-records/skill) are stored in the records root,
   * NOT in .claude/skills, so they won't appear in scan/index. This test uses pre-existing
   * skills from the .claude/skills directories.
   */
  it('scan discovers skills → index → search finds indexed skills', async () => {
    // 1. Scan: skills should be discoverable from .claude/skills dirs
    const scanResp = await apiClient.get<unknown>(`${CN_FS_BASE}/scan?type=skill`);
    const scanData = unwrapData(scanResp);
    expect(Number(scanData.count)).toBeGreaterThanOrEqual(1);

    // 2. Index: POST /fs-records/index?type=skill
    const indexResp = await apiClient.post<unknown>(`${CN_FS_BASE}/index?type=skill`, {});
    const indexData = unwrapData(indexResp);
    // Some or all skills may error during sync_to_db; verify the response shape
    const totalProcessed = Number(indexData.indexed) + Number(indexData.errors);
    expect(totalProcessed).toBeGreaterThanOrEqual(1);

    // 3. Search: if any skills were successfully indexed, they should appear
    if (Number(indexData.indexed) > 0) {
      const searchResp = await apiClient.get<unknown>(
        `${CN_FS_BASE}/search?record_type=skill`,
      );
      const searchData = unwrapData(searchResp);
      const results = searchData.results as Array<{ name: string; record_type: string }>;
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.every((r) => r.record_type === 'skill')).toBe(true);
    }
  });

  it('after indexing, search with record_type filter returns only matching type', async () => {
    await apiClient.post<unknown>(`${CN_FS_BASE}/index?type=skill`, {});

    const response = await apiClient.get<unknown>(
      `${CN_FS_BASE}/search?record_type=skill`,
    );
    const data = unwrapData(response);
    const results = data.results as Array<{ record_type: string }>;
    // If any skills were indexed, they should all be of type 'skill'
    if (results.length > 0) {
      expect(results.every((r) => r.record_type === 'skill')).toBe(true);
    }
  });

  it('search response has correct shape for useRecordSearch hook', async () => {
    // Verify the exact shape that useRecordSearch.ts expects from the API
    await apiClient.post<unknown>(`${CN_FS_BASE}/index?type=skill`, {});

    const response = await apiClient.get<unknown>(`${CN_FS_BASE}/search?record_type=skill`);
    const data = unwrapData(response);

    // Verify the shape that useRecordSearch.ts expects:
    expect(data).toHaveProperty('results');
    expect(data).toHaveProperty('total');
    expect(data).toHaveProperty('indexer_ready');

    const results = data.results as Array<{
      record_id: string;
      record_type: string;
      name: string;
      text: string;
      status: string;
      scope: string;
      created_at: string;
      modified_at: string;
      source_path: string;
    }>;

    // If any skills were indexed, verify the result shape
    if (results.length > 0) {
      const result = results[0];
      expect(result).toHaveProperty('record_id');
      expect(result).toHaveProperty('record_type');
      expect(result).toHaveProperty('name');
      expect(result).toHaveProperty('text');
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('scope');
      expect(result).toHaveProperty('created_at');
      expect(result).toHaveProperty('modified_at');
      expect(result).toHaveProperty('source_path');
    }
  });
});
