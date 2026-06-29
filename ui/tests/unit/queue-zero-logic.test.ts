import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

// Source-assertion contract test. The prompt queue is backend-owned: the panel
// reads the reflected ``process.queue`` entity field and mutates ONLY through
// the entity's action methods. There is no client-side queue state, no fetch,
// and no idle-injection on the frontend. These assertions pin that contract so
// the old "frontend drives the queue" pattern can't creep back.

const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf-8');

const panelSource = read(
  '../../src/components/terminal/interactive-terminal/side-windows/QueuePanel.tsx',
);
const entitySource = read('../../../ts_sdk/src/process/agentic-process.ts');

// Slice just the openTab method so launch-path assertions can't be confused by
// the unrelated static execute() method elsewhere in the file.
const openTabStart = entitySource.indexOf('static async openTab(');
const openTabBody = entitySource.slice(
  openTabStart,
  entitySource.indexOf('static async', openTabStart + 1),
);

describe('Prompt queue is zero-logic on the frontend', () => {
  it('QueuePanel reads the reflected entity queue state reactively', () => {
    // useEntity subscribes so data_op queue updates re-render the panel.
    expect(panelSource).toMatch(/useEntity/);
    expect(panelSource).toMatch(/\.queue/);
    expect(panelSource).toMatch(/entry\.prompt/);
  });

  it('QueuePanel has no nested entry shape and no injection logic', () => {
    expect(panelSource).not.toMatch(/queue_entry_data/);
    expect(panelSource).not.toMatch(/sendInput/);
  });

  it('QueuePanel mutates only through the entity action methods', () => {
    for (const call of [
      '.enqueue(',
      '.dequeue(',
      '.clearQueue(',
      '.setQueueEnabled(',
    ]) {
      expect(panelSource).toContain(call);
    }
  });

  it('AgenticProcess wires the four backend queue actions', () => {
    for (const action of ["'enqueue'", "'dequeue'", "'clear-queue'", "'set-queue-enabled'"]) {
      expect(entitySource).toContain(action);
    }
  });

  it('openTab seeds the launch prompt onto the queue instead of the racy execute', () => {
    // Routed through createProcess({ launchPrompt }) so it is enqueued
    // server-side BEFORE the visible auto-start (deterministic launch arg).
    expect(openTabBody).toContain('launchPrompt');
    expect(openTabBody).not.toContain("ActionInfo('execute'");
  });

  it('the old client-side queue hook is deleted', () => {
    expect(existsSync(resolve(__dirname, '../../src/hooks/useAgenticQueue.ts'))).toBe(false);
  });
});
