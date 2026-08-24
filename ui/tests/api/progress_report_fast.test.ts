/**
 * Fast progress_report WebSocket event tests.
 *
 * Every progress_report event is an IndexProgressTable snapshot. There are no
 * per-entity events and no separate sub-activity/job-level event shapes.
 *
 * Requires a running backend at localhost:9007.
 */

import { apiClient, ComputeNode, ConnectionManager, GRAPH_API_PREFIX } from '@sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

const CN_FS_BASE = `${GRAPH_API_PREFIX}/${ComputeNode.type}/@local/fs-records`;

interface TypeProgressRow {
  type_name: string;
  done: number;
  total: number;
  errors: number;
  skipped: number;
}

interface IndexProgressTable {
  job_name: 'scan' | 'index';
  rows: TypeProgressRow[];
  current: string | null;
  done: number;
  total: number;
  text: string | null;
  ts: string;
}

async function waitForConnection(manager: ConnectionManager) {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WS connect timeout')), 5000);
    const check = () => {
      if (manager.connected) {
        clearTimeout(timeout);
        resolve();
      } else {
        setTimeout(check, 200);
      }
    };
    check();
  });
}

const _createdSkillIds: string[] = [];

async function createSkill(name: string): Promise<string> {
  const res = await apiClient.post<unknown>(`${CN_FS_BASE}/skill`, {
    name,
    description: `desc for ${name}`,
  });
  const d = (res as any)?.data ?? res;
  const id = (d as any).id as string;
  _createdSkillIds.push(id);
  return id;
}

async function collectProgressDuring(
  manager: ConnectionManager,
  operation: () => Promise<unknown>,
  settleMs = 500,
): Promise<IndexProgressTable[]> {
  const tables: IndexProgressTable[] = [];

  const handler = (_typeId: unknown, flowData: Record<string, unknown>) => {
    if (flowData?.element_type !== 'progress_report') return;
    const attrs = flowData?.attributes as Partial<IndexProgressTable> | undefined;
    if (!attrs?.job_name || !Array.isArray(attrs.rows)) return;
    tables.push(attrs as IndexProgressTable);
  };

  manager.on('on_flow_data', handler);
  try {
    await operation();
    await new Promise((r) => setTimeout(r, settleMs));
  } finally {
    manager.off('on_flow_data', handler);
  }

  return tables;
}

function assertTableShape(table: IndexProgressTable, jobName: 'scan' | 'index') {
  expect(table.job_name).toBe(jobName);
  expect(Array.isArray(table.rows)).toBe(true);
  expect(typeof table.done).toBe('number');
  expect(typeof table.total).toBe('number');
  expect(table.current === null || typeof table.current === 'string').toBe(true);
  // `text` is a phase marker: null mid-run, a phase label while a long
  // sub-phase runs (e.g. "sweeping" for the orphan sweep), or "complete" on
  // the terminal snapshot. The terminal "complete" contract is asserted on
  // `final` per test, below.
  expect(table.text === null || typeof table.text === 'string').toBe(true);
  expect(typeof table.ts).toBe('string');

  for (const row of table.rows) {
    expect(typeof row.type_name).toBe('string');
    expect(typeof row.done).toBe('number');
    expect(typeof row.total).toBe('number');
    expect(typeof row.errors).toBe('number');
    expect(typeof row.skipped).toBe('number');
    expect(row.done).toBeGreaterThanOrEqual(0);
    expect(row.total).toBeGreaterThanOrEqual(0);
  }
}

function findRow(table: IndexProgressTable, typeName: string) {
  return table.rows.find((row) => row.type_name === typeName);
}

describe('progress_report fast tests', () => {
  const info = getTestSignupInfo();

  beforeEach(async (context: any) => {
    await apiTestSetup(info, context.task.name);
  });

  afterEach(async () => {
    while (_createdSkillIds.length) {
      const id = _createdSkillIds.pop()!;
      try {
        await apiClient.delete(`${CN_FS_BASE}/skill/${id}`);
      } catch { /* best effort */ }
    }
  });

  it('aggregate scan emits IndexProgressTable snapshots', async () => {
    const manager = ConnectionManager.getInstance();
    await waitForConnection(manager);

    for (let i = 0; i < 3; i++) {
      await createSkill(`fast-scan-${Date.now()}-${i}`);
    }

    const tables = await collectProgressDuring(manager, () =>
      apiClient.get(`${CN_FS_BASE}/scan?trigger=manual&limit_types=5`),
    );

    // Assert on the scan-labelled events only (same job_name filter as the
    // index sibling below): the collector sees EVERY progress broadcast in
    // the window, and a concurrent job — e.g. the detached startup
    // `_index_system_assets` pass, still running on a cold CI instance —
    // legitimately interleaves its own 'index' snapshots.
    const scanTables = tables.filter((t) => t.job_name === 'scan');
    expect(scanTables.length).toBeGreaterThan(0);
    for (const table of scanTables) {
      assertTableShape(table, 'scan');
      expect(table.total).toBe(0);
    }
    const final = scanTables[scanTables.length - 1];
    expect(final.text).toBe('complete');
    expect(final.current).toBeNull();
  }, 30000);

  it('aggregate index emits IndexProgressTable snapshots', async () => {
    const manager = ConnectionManager.getInstance();
    await waitForConnection(manager);

    for (let i = 0; i < 3; i++) {
      await createSkill(`fast-index-${Date.now()}-${i}`);
    }

    const tables = await collectProgressDuring(manager, () =>
      apiClient.post(`${CN_FS_BASE}/index?limit_types=5&limit_per_type=20`),
    );

    expect(tables.length).toBeGreaterThan(0);
    // An aggregate index drives the SAME activity through two phases:
    // discovery forwards the inner scan's per-type snapshots (job_name
    // 'scan') so the UI renders the by-type table immediately, then the
    // per-record index loop emits 'index' snapshots. Assert the index-phase
    // shape on the index-labelled events (mirrors the Python sibling's
    // job_name filter); the forwarded scan snapshots are a valid earlier
    // phase, not a violation.
    const indexTables = tables.filter((t) => t.job_name === 'index');
    expect(indexTables.length).toBeGreaterThan(0);
    for (const table of indexTables) {
      assertTableShape(table, 'index');
      for (const row of table.rows) {
        expect(row.done).toBeLessThanOrEqual(row.total);
      }
    }
    const final = indexTables[indexTables.length - 1];
    expect(final.text).toBe('complete');
    expect(final.current).toBeNull();
  }, 30000);

  it('scan table done values are monotonic', async () => {
    const manager = ConnectionManager.getInstance();
    await waitForConnection(manager);

    for (let i = 0; i < 3; i++) {
      await createSkill(`monotonic-scan-${Date.now()}-${i}`);
    }

    const tables = await collectProgressDuring(manager, () =>
      apiClient.get(`${CN_FS_BASE}/scan?trigger=manual&type=skill`),
    );

    // Same job_name filter as the aggregate-scan test above: the collector sees
    // EVERY progress broadcast in the window, and a concurrent job (e.g. the
    // detached startup index pass) legitimately interleaves its own snapshots.
    // Two interleaved jobs' `done` counters are not one monotonic sequence.
    const scanTables = tables.filter((t) => t.job_name === 'scan');
    expect(scanTables.length).toBeGreaterThan(0);
    const doneSeq = scanTables.map((table) => table.done);
    for (let i = 1; i < doneSeq.length; i++) {
      expect(doneSeq[i]).toBeGreaterThanOrEqual(doneSeq[i - 1]);
    }
  }, 30000);

  it('per-type scan (?type=skill) completes the skill row', async () => {
    const manager = ConnectionManager.getInstance();
    await waitForConnection(manager);

    for (let i = 0; i < 3; i++) {
      await createSkill(`per-type-s-${Date.now()}-${i}`);
    }

    const tables = await collectProgressDuring(manager, () =>
      apiClient.get(`${CN_FS_BASE}/scan?type=skill&trigger=manual`),
    );

    const scanTables = tables.filter((t) => t.job_name === 'scan');
    expect(scanTables.length).toBeGreaterThan(0);
    const final = scanTables[scanTables.length - 1];
    assertTableShape(final, 'scan');
    expect(final.text).toBe('complete');
    const skill = findRow(final, 'skill');
    expect(skill).toBeDefined();
    // Scan is a discovery walk: the row's `done` ticks up as files are found,
    // but `total` is not known up front and is NOT backfilled at completion
    // (it stays 0 — same contract as the aggregate-scan test above and the
    // Python sibling, which asserts only done >= created). `done === total`
    // is an index-phase invariant (asserted in the per-type index test
    // below), not a scan one.
    expect(skill!.done).toBeGreaterThanOrEqual(3);
  }, 30000);

  it('per-type index (?type=skill) completes the skill row', async () => {
    const manager = ConnectionManager.getInstance();
    await waitForConnection(manager);

    for (let i = 0; i < 3; i++) {
      await createSkill(`per-type-i-${Date.now()}-${i}`);
    }

    const tables = await collectProgressDuring(manager, () =>
      apiClient.post(`${CN_FS_BASE}/index?type=skill`),
    );

    // A concurrent scan pass can emit the LAST snapshot inside the window, so
    // take the final table of the INDEX job rather than of the raw stream.
    const indexTables = tables.filter((t) => t.job_name === 'index');
    expect(indexTables.length).toBeGreaterThan(0);
    const final = indexTables[indexTables.length - 1];
    assertTableShape(final, 'index');
    expect(final.text).toBe('complete');
    const skill = findRow(final, 'skill');
    expect(skill).toBeDefined();
    expect(skill!.total).toBeGreaterThanOrEqual(3);
    expect(skill!.done).toBe(skill!.total);
    // 5s is the asserted SLO for an unscoped per-type index, not a hang guard.
    // `?type=skill` filters PARSING, never the WALK (index_function.py: "Always
    // runs a full scan"), so this test is the only thing gating how many roots
    // that walk covers. It sat green at ~26s while ~/.flow/instances/* were
    // being walked — 155,749 of 165,666 dirs — under the old 30s cap.
    // Measured after gating flow_home out of project discovery: endpoint 4.0-4.2s,
    // test body 4.6s. NEVER RAISE THIS. A regression here means the index is
    // walking roots it should not; fix the roots, not the number.
  }, 5000);
});
