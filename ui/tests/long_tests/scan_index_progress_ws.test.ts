/**
 * Scan/index per-record progress WebSocket events.
 *
 * Validates that the backend generators broadcast `flow_data_msg` messages
 * with `scan_progress` / `index_progress` element types during scan and index
 * operations, and that `SystemToolsService` correctly reflects those updates
 * through its `activityProgress` field.
 *
 * Requires a running backend at localhost:9007.
 */

import { apiClient, ComputeNode, ConnectionManager, GRAPH_API_PREFIX, ActivityProgress, systemTools } from '@sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Base URL for fs-records actions on the @local compute node. */
const CN_FS_BASE = `${GRAPH_API_PREFIX}/${ComputeNode.type}/@local/fs-records`;

/** Wait until the ConnectionManager reports it is connected. */
async function waitForConnection(manager: ConnectionManager) {
  await vi.waitFor(
    () => {
      if (!manager.connected) throw new Error('Cannot connect to ws server');
    },
    { timeout: 5000, interval: 500 },
  );
  expect(manager.connected).toBe(true);
}

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
  const response = await apiClient.post<unknown>(`${CN_FS_BASE}/skill`, { name, description });
  const data = unwrapData(response);
  return data.id as string;
}

/** Create N skills with unique names based on a prefix and a timestamp. */
async function createSkills(n: number, prefix: string): Promise<string[]> {
  const ids: string[] = [];
  const ts = Date.now();
  for (let i = 0; i < n; i++) {
    const id = await createSkill(`${prefix}-${ts}-${i}`, `description ${i}`);
    ids.push(id);
  }
  return ids;
}

/** Collect on_flow_data events while an async operation runs, then a brief settle period. */
async function collectFlowDataDuring(
  manager: ConnectionManager,
  operation: () => Promise<unknown>,
  settleMs = 800,
): Promise<Array<{ typeId: unknown; flowData: Record<string, unknown> }>> {
  const received: Array<{ typeId: unknown; flowData: Record<string, unknown> }> = [];
  const handler = (typeId: unknown, flowData: Record<string, unknown>) => {
    received.push({ typeId, flowData });
  };
  manager.on('on_flow_data', handler);
  try {
    await operation();
    await new Promise((r) => setTimeout(r, settleMs));
  } finally {
    manager.off('on_flow_data', handler);
  }
  return received;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('scan/index per-record progress events', () => {
  const info = getTestSignupInfo();

  beforeEach(async (context: any) => {
    await apiTestSetup(info, context.task.name);
  });

  // -------------------------------------------------------------------------
  // Test 1: scan_progress events arrive via connectionManager on_flow_data
  // -------------------------------------------------------------------------

  it('scan_progress events arrive via connectionManager on_flow_data', async () => {
    const manager = ConnectionManager.getInstance();
    await waitForConnection(manager);

    // Create 30 skill records so there is something to scan.
    await createSkills(30, 'scan-progress-test');

    // Trigger an aggregate scan (no ?type= filter) — this is the code path
    // that calls scan_type_progress() and emits progress events per-record.
    // limit_types=10 keeps the test fast while ensuring enough types are covered.
    const received = await collectFlowDataDuring(manager, () =>
      apiClient.get(`${CN_FS_BASE}/scan?trigger=manual&limit_types=10`),
    );

    // Accept scan_progress events for ANY type (not just 'skill', since the
    // order of registered types is not deterministic).
    // Accept sub-activity progress_report events for ANY type (sub_activity_name != null)
    const progressEvents = received.filter(
      (e) =>
        e.flowData?.element_type === 'progress_report' &&
        (e.flowData?.attributes as Record<string, unknown>)?.sub_activity_name != null,
    );

    // At least one progress event must have been received.
    expect(progressEvents.length).toBeGreaterThan(0);

    // Validate the shape of every received sub-activity event.
    for (const evt of progressEvents) {
      expect(evt.flowData.element_type).toBe('progress_report');
      const attrs = evt.flowData.attributes as Record<string, unknown>;
      expect(attrs.job_name).toBe('scan');
      expect(typeof attrs.sub_activity_name).toBe('string');
      expect(typeof attrs.done).toBe('number');
      expect(typeof attrs.total).toBe('number');
      expect(attrs.done as number).toBeGreaterThan(0);
      expect(attrs.total as number).toBeGreaterThan(0);
      expect(attrs.done as number).toBeLessThanOrEqual(attrs.total as number);
    }

    // For each type, the final event must have done === total.
    const byType = new Map<string, typeof progressEvents>();
    for (const evt of progressEvents) {
      const t = (evt.flowData.attributes as Record<string, unknown>).sub_activity_name as string;
      if (!byType.has(t)) byType.set(t, []);
      byType.get(t)!.push(evt);
    }
    for (const [, events] of byType) {
      const lastAttrs = events[events.length - 1].flowData.attributes as Record<string, unknown>;
      expect(lastAttrs.done).toBe(lastAttrs.total);
      // done must be monotonically non-decreasing within each type.
      const doneSeq = events.map((e) => (e.flowData.attributes as Record<string, unknown>).done as number);
      for (let i = 1; i < doneSeq.length; i++) {
        expect(doneSeq[i]).toBeGreaterThanOrEqual(doneSeq[i - 1]);
      }
    }

    // Also validate job-level progress_report events (sub_activity_name=null)
    const jobEvents = received.filter(
      (e) =>
        e.flowData?.element_type === 'progress_report' &&
        (e.flowData?.attributes as Record<string, unknown>)?.sub_activity_name == null,
    );
    expect(jobEvents.length).toBeGreaterThan(0);
    for (const evt of jobEvents) {
      const attrs = evt.flowData.attributes as Record<string, unknown>;
      expect(attrs.job_name).toBe('scan');
      expect(attrs.sub_activity_name).toBeNull();
    }
  }, 120000);

  // -------------------------------------------------------------------------
  // Test 2: index_progress events arrive via connectionManager on_flow_data
  // -------------------------------------------------------------------------

  it('index_progress events arrive via connectionManager on_flow_data', async () => {
    const manager = ConnectionManager.getInstance();
    await waitForConnection(manager);

    // Create 30 skill records.
    await createSkills(30, 'index-progress-test');

    // Trigger aggregate index (no ?type= filter) — calls index_type_progress().
    // limit_types=10 keeps the test fast.
    const received = await collectFlowDataDuring(manager, () =>
      apiClient.post(`${CN_FS_BASE}/index?limit_types=10`),
    );

    // Accept sub-activity progress_report events (sub_activity_name != null)
    const progressEvents = received.filter(
      (e) =>
        e.flowData?.element_type === 'progress_report' &&
        (e.flowData?.attributes as Record<string, unknown>)?.sub_activity_name != null,
    );

    // At least one event must have been received.
    expect(progressEvents.length).toBeGreaterThan(0);

    // Validate every sub-activity event's shape.
    for (const evt of progressEvents) {
      expect(evt.flowData.element_type).toBe('progress_report');
      const attrs = evt.flowData.attributes as Record<string, unknown>;
      expect(attrs.job_name).toBe('index');
      expect(typeof attrs.sub_activity_name).toBe('string');
      expect(typeof attrs.done).toBe('number');
      expect(typeof attrs.total).toBe('number');
      expect(typeof attrs.skipped).toBe('number');
      expect(typeof attrs.errors).toBe('number');
      expect(attrs.done as number).toBeGreaterThan(0);
      expect(attrs.total as number).toBeGreaterThan(0);
      expect(attrs.skipped as number).toBeGreaterThanOrEqual(0);
      expect(attrs.errors as number).toBeGreaterThanOrEqual(0);
    }

    // Group by type: check last-event completeness and monotonicity.
    const byType = new Map<string, typeof progressEvents>();
    for (const evt of progressEvents) {
      const t = (evt.flowData.attributes as Record<string, unknown>).sub_activity_name as string;
      if (!byType.has(t)) byType.set(t, []);
      byType.get(t)!.push(evt);
    }
    for (const [, events] of byType) {
      const lastAttrs = events[events.length - 1].flowData.attributes as Record<string, unknown>;
      expect(lastAttrs.done).toBe(lastAttrs.total);
    }

    // Also validate job-level progress_report events
    const jobEvents = received.filter(
      (e) =>
        e.flowData?.element_type === 'progress_report' &&
        (e.flowData?.attributes as Record<string, unknown>)?.sub_activity_name == null,
    );
    expect(jobEvents.length).toBeGreaterThan(0);
    for (const evt of jobEvents) {
      const attrs = evt.flowData.attributes as Record<string, unknown>;
      expect(attrs.job_name).toBe('index');
      expect(attrs.sub_activity_name).toBeNull();
    }
  }, 120000);

  // -------------------------------------------------------------------------
  // Test 3: SystemToolsService.activityProgress.recordsDone updates during scan
  // -------------------------------------------------------------------------

  it('SystemToolsService.activityProgress.recordsDone updates during scan', async () => {
    const manager = ConnectionManager.getInstance();
    await waitForConnection(manager);

    // Discover the first registered type so we can prime activityProgress.current
    // to a type that will actually appear in the scan's progress events.
    const typesResp = unwrapData(await apiClient.get<unknown>(CN_FS_BASE));
    const allTypes = typesResp.types as string[];
    expect(allTypes.length).toBeGreaterThan(0);
    const firstType = allTypes[0];

    // Prime activityProgress so the SystemToolsService listener accepts events.
    // Set currentActivity to 'scan' so job_name check passes.
    (systemTools as any).currentActivity = 'scan';
    (systemTools as any).activityProgress = {
      total: 1,
      done: [],
      current: firstType,
      pending: [],
    } as ActivityProgress;

    // Track state_changed events emitted by systemTools.
    let lastProgress: ActivityProgress | null = null;
    const stateHandler = () => {
      lastProgress = systemTools.activityProgress;
    };
    systemTools.on('state_changed', stateHandler);

    try {
      // Trigger aggregate scan limited to 10 types so firstType (index 0) is included.
      await apiClient.get(`${CN_FS_BASE}/scan?trigger=manual&limit_types=10`);

      // Wait until recordsDone is populated (from sub-activity progress_report events).
      await vi.waitFor(
        () => {
          if (!systemTools.activityProgress?.recordsDone) {
            throw new Error('activityProgress.recordsDone has not been set yet');
          }
        },
        { timeout: 15000, interval: 200 },
      );

      // Validate the progress values.
      expect(systemTools.activityProgress!.recordsDone).toBeGreaterThan(0);
      expect(systemTools.activityProgress!.recordsTotal).toBeGreaterThan(0);
      expect(lastProgress).not.toBeNull();

      // Also check that job-level fields are populated
      await vi.waitFor(
        () => {
          if (systemTools.activityProgress?.jobDone == null) {
            throw new Error('activityProgress.jobDone has not been set yet');
          }
        },
        { timeout: 15000, interval: 200 },
      );
      expect(systemTools.activityProgress!.jobDone).toBeGreaterThanOrEqual(0);
    } finally {
      systemTools.off('state_changed', stateHandler);
    }
  }, 120000);
});
