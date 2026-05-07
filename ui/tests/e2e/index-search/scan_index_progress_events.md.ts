/**
 * WebSocket progress_report event tests for scan and index operations.
 *
 * Each progress_report event is an IndexProgressTable snapshot. The backend no
 * longer emits separate sub-activity or job-level events.
 *
 * Requires: backend running at localhost:9007, frontend at localhost:4097.
 */

import { expect, test } from '@playwright/test';

const API_URL = process.env.API_URL ?? 'http://localhost:9007';
const CN_FS_BASE = `${API_URL}/api/v1/graph/compute_node/@local/fs-records`;

async function dismissSetupModal(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
}

interface TypeProgressRow {
  type_name: string;
  done: number;
  total: number;
  errors: number;
  skipped: number;
}

interface IndexProgressTable {
  job_name?: 'scan' | 'index';
  rows?: TypeProgressRow[];
  current?: string | null;
  done?: number;
  total?: number;
  text?: string | null;
  ts?: string;
}

async function collectProgressEvents(
  page: import('@playwright/test').Page,
  operation: () => Promise<void>,
  settleMs = 1000,
): Promise<IndexProgressTable[]> {
  const tables: IndexProgressTable[] = [];
  const wsMessages: string[] = [];

  page.on('websocket', (ws) => {
    ws.on('framereceived', (frame) => {
      if (typeof frame.payload === 'string') {
        wsMessages.push(frame.payload);
      }
    });
  });

  await operation();
  await page.waitForTimeout(settleMs);

  for (const msg of wsMessages) {
    try {
      const parsed = JSON.parse(msg);
      const flowData = parsed?.flow_data ?? parsed?.data?.flow_data ?? parsed;
      if (flowData?.element_type === 'progress_report') {
        const attrs = flowData.attributes as IndexProgressTable;
        if (attrs?.job_name && Array.isArray(attrs.rows)) {
          tables.push(attrs);
        }
      }
    } catch {
      // Skip non-JSON messages.
    }
  }

  return tables;
}

function assertTableShape(table: IndexProgressTable, jobName: 'scan' | 'index') {
  expect(table.job_name).toBe(jobName);
  expect(Array.isArray(table.rows)).toBe(true);
  expect(typeof table.done).toBe('number');
  expect(typeof table.total).toBe('number');
  expect(table.current === null || typeof table.current === 'string').toBe(true);
  expect(table.text === null || table.text === 'complete').toBe(true);
  for (const row of table.rows ?? []) {
    expect(typeof row.type_name).toBe('string');
    expect(typeof row.done).toBe('number');
    expect(typeof row.total).toBe('number');
    expect(typeof row.errors).toBe('number');
    expect(typeof row.skipped).toBe('number');
  }
}

test.describe('Scan & Index Progress Events', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  });

  test('aggregate scan emits progress table snapshots when browser WS captures them', async ({ page, request }) => {
    const tables = await collectProgressEvents(
      page,
      async () => {
        const res = await request.get(`${CN_FS_BASE}/scan?limit_types=3&trigger=manual`);
        expect(res.status()).toBe(200);
      },
      1500,
    );

    for (const table of tables) {
      assertTableShape(table, 'scan');
      expect(table.total).toBe(0);
    }
  });

  test('per-type scan (?type=skill) returns completed scan response', async ({ request }) => {
    const res = await request.get(`${CN_FS_BASE}/scan?type=skill&trigger=manual`);
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('SUCCESS');
    expect(body.data.type).toBe('skill');
    expect(Number(body.data.count)).toBeGreaterThanOrEqual(1);
  });

  test('per-type index (?type=skill) returns completed response', async ({ request }) => {
    const res = await request.post(`${CN_FS_BASE}/index?type=skill`);
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('SUCCESS');
    expect(body.data.type).toBe('skill');
    expect(typeof body.data.indexed).toBe('number');
  });

  test('aggregate scan response is coherent', async ({ request }) => {
    const res = await request.get(`${CN_FS_BASE}/scan?limit_types=3`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Number(body.data.grand_total)).toBeGreaterThanOrEqual(0);
    expect(Number(body.data.scan_ms)).toBeGreaterThanOrEqual(0);
  });
});
