import { describe, expect, it } from 'vitest';
import { WorkerStatus } from '@sdk';
import { workerStatusConfig } from '@src/components/agentic-progress/shared/status-indicator';
import { workerStatusLabel } from '@src/components/footer/worker-status-label';

/**
 * Every WorkerStatus member must have a display entry. The maps are
 * Record<WorkerStatus, …> but nothing type-checks them app-wide, and a
 * missing key crashes the status pill (`resolveConfig(...).label` on
 * undefined) — exactly what a new wire value like `pending_user` would do.
 */
describe('WorkerStatus display maps', () => {
  it('every status has an indicator config and a footer label', () => {
    for (const status of Object.values(WorkerStatus)) {
      expect(workerStatusConfig[status], `indicator config for ${status}`).toBeDefined();
      expect(workerStatusLabel(status, false), `footer label for ${status}`).not.toBe('');
    }
  });
});
