/**
 * Fast progress_report WebSocket event tests.
 *
 * Tests both sub-activity (per-record) and job-level (per-type) progress_report
 * events using minimal record counts (3 records) so they run quickly.
 *
 * Requires a running backend at localhost:9007.
 */

import { apiClient, ComputeNode, ConnectionManager, GRAPH_API_PREFIX } from '@sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

const CN_FS_BASE = `${GRAPH_API_PREFIX}/${ComputeNode.type}/@local/fs-records`;

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

async function createSkill(name: string): Promise<string> {
  const res = await apiClient.post<unknown>(`${CN_FS_BASE}/skill`, {
    name,
    description: `desc for ${name}`,
  });
  const d = (res as any)?.data ?? res;
  return (d as any).id as string;
}

/** Collect progress_report events during an operation and settle for settleMs. */
async function collectProgressDuring(
  manager: ConnectionManager,
  operation: () => Promise<unknown>,
  settleMs = 500,
) {
  const subActivity: Array<Record<string, unknown>> = [];
  const jobLevel: Array<Record<string, unknown>> = [];

  const handler = (_typeId: unknown, flowData: Record<string, unknown>) => {
    if (flowData?.element_type !== 'progress_report') return;
    const attrs = flowData?.attributes as Record<string, unknown>;
    if (attrs?.sub_activity_name != null) {
      subActivity.push(attrs);
    } else {
      jobLevel.push(attrs);
    }
  };

  manager.on('on_flow_data', handler);
  try {
    await operation();
    await new Promise((r) => setTimeout(r, settleMs));
  } finally {
    manager.off('on_flow_data', handler);
  }

  return { subActivity, jobLevel };
}

describe('progress_report fast tests', () => {
  const info = getTestSignupInfo();

  beforeEach(async (context: any) => {
    await apiTestSetup(info, context.task.name);
  });

  it('aggregate scan emits sub-activity and job-level progress_report events', async () => {
    const manager = ConnectionManager.getInstance();
    await waitForConnection(manager);

    // Create 3 skill records
    for (let i = 0; i < 3; i++) {
      await createSkill(`fast-scan-${Date.now()}-${i}`);
    }

    const { subActivity, jobLevel } = await collectProgressDuring(manager, () =>
      apiClient.get(`${CN_FS_BASE}/scan?trigger=manual&limit_types=5`),
    );

    // Must have at least one sub-activity event
    expect(subActivity.length).toBeGreaterThan(0);

    // Validate sub-activity shape
    for (const attrs of subActivity) {
      expect(attrs.job_name).toBe('scan');
      expect(typeof attrs.sub_activity_name).toBe('string');
      expect(typeof attrs.done).toBe('number');
      expect(typeof attrs.total).toBe('number');
      expect(typeof attrs.skipped).toBe('number');
      expect(typeof attrs.errors).toBe('number');
      expect(attrs.done as number).toBeGreaterThan(0);
      expect(attrs.total as number).toBeGreaterThan(0);
    }

    // Must have at least one job-level event
    expect(jobLevel.length).toBeGreaterThan(0);

    // Validate job-level shape
    for (const attrs of jobLevel) {
      expect(attrs.job_name).toBe('scan');
      expect(attrs.sub_activity_name).toBeNull();
      expect(typeof attrs.done).toBe('number');
      expect(typeof attrs.total).toBe('number');
    }
  }, 30000);

  it('aggregate index emits sub-activity and job-level progress_report events', async () => {
    const manager = ConnectionManager.getInstance();
    await waitForConnection(manager);

    // Create 3 skill records
    for (let i = 0; i < 3; i++) {
      await createSkill(`fast-index-${Date.now()}-${i}`);
    }

    const { subActivity, jobLevel } = await collectProgressDuring(manager, () =>
      apiClient.post(`${CN_FS_BASE}/index?limit_types=5`),
    );

    // Must have at least one sub-activity event
    expect(subActivity.length).toBeGreaterThan(0);

    // Validate sub-activity shape
    for (const attrs of subActivity) {
      expect(attrs.job_name).toBe('index');
      expect(typeof attrs.sub_activity_name).toBe('string');
      expect(typeof attrs.done).toBe('number');
      expect(typeof attrs.total).toBe('number');
      expect(typeof attrs.skipped).toBe('number');
      expect(typeof attrs.errors).toBe('number');
    }

    // Must have at least one job-level event
    expect(jobLevel.length).toBeGreaterThan(0);

    // Validate job-level shape
    for (const attrs of jobLevel) {
      expect(attrs.job_name).toBe('index');
      expect(attrs.sub_activity_name).toBeNull();
      expect(typeof attrs.done).toBe('number');
      expect(typeof attrs.total).toBe('number');
    }
  }, 30000);

  it('sub-activity and job-level events are interleaved during scan', async () => {
    const manager = ConnectionManager.getInstance();
    await waitForConnection(manager);

    // Create 3 records
    for (let i = 0; i < 3; i++) {
      await createSkill(`interleave-${Date.now()}-${i}`);
    }

    // Scan only the skill type — guarantees the 3 records we just created produce events
    const { subActivity, jobLevel } = await collectProgressDuring(manager, () =>
      apiClient.get(`${CN_FS_BASE}/scan?trigger=manual&type=skill`),
    );

    expect(subActivity.length).toBeGreaterThan(0);
    expect(jobLevel.length).toBeGreaterThan(0);

    // Job-level done values must be non-decreasing
    const doneSeq = jobLevel.map((a) => a.done as number);
    for (let i = 1; i < doneSeq.length; i++) {
      expect(doneSeq[i]).toBeGreaterThanOrEqual(doneSeq[i - 1]);
    }
  }, 30000);

  it('per-type scan (?type=skill) emits progress_report events', async () => {
    const manager = ConnectionManager.getInstance();
    await waitForConnection(manager);

    for (let i = 0; i < 3; i++) {
      await createSkill(`per-type-s-${Date.now()}-${i}`);
    }

    const { subActivity, jobLevel } = await collectProgressDuring(manager, () =>
      apiClient.get(`${CN_FS_BASE}/scan?type=skill&trigger=manual`),
    );

    expect(subActivity.length).toBeGreaterThan(0);
    const lastSub = subActivity[subActivity.length - 1];
    expect(lastSub.sub_activity_name).toBe('skill');
    expect(lastSub.done).toBe(lastSub.total);

    expect(jobLevel.length).toBeGreaterThan(0);
    expect(jobLevel[0].job_name).toBe('scan');
  }, 30000);

  it('per-type index (?type=skill) emits progress_report events', async () => {
    const manager = ConnectionManager.getInstance();
    await waitForConnection(manager);

    for (let i = 0; i < 3; i++) {
      await createSkill(`per-type-i-${Date.now()}-${i}`);
    }

    const { subActivity, jobLevel } = await collectProgressDuring(manager, () =>
      apiClient.post(`${CN_FS_BASE}/index?type=skill`),
    );

    expect(subActivity.length).toBeGreaterThan(0);
    const lastSub = subActivity[subActivity.length - 1];
    expect(lastSub.sub_activity_name).toBe('skill');
    expect(lastSub.done).toBe(lastSub.total);

    expect(jobLevel.length).toBeGreaterThan(0);
    expect(jobLevel[0].job_name).toBe('index');
  }, 30000);
});
