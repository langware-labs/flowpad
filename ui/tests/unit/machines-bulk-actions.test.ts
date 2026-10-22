/**
 * The pure halves of bulk actions on machines: which machines each action
 * applies to, and the runner that must finish every machine even when some fail.
 */
import { describe, expect, it } from 'vitest';
import { ComputeNode, ExecutionEnvironmentStatus } from '@sdk';
import { runLimited } from '@src/lib/run-limited';
import { bulkSummary, bulkTargets } from '@src/pages/hub-home/machines-bulk';

function node(id: string, extra: Record<string, unknown> = {}): ComputeNode {
  return new ComputeNode({ id: `node-${id.charCodeAt(0) - 96}`, name: id, ...extra } as never);
}

describe('bulkTargets', () => {
  it('applies each action only where the card would offer it', () => {
    const ready = node('a', { node_provider_id: 'p', logged_in_user: 'Me@X.io' });
    const unreachable = node('b', { node_provider_id: 'p' });
    const unlaunched = node('c');
    const t = bulkTargets(
      [ready, unreachable, unlaunched],
      {
        'node-1': { status: ExecutionEnvironmentStatus.READY },
        'node-2': { status: ExecutionEnvironmentStatus.ERROR },
      } as never,
      'me@x.io',
    );
    expect(t.upgrade.map((n) => n.name)).toEqual(['a']);
    expect(t.signout.map((n) => n.name)).toEqual(['a']);
    expect(t.delete.map((n) => n.name)).toEqual(['a', 'b', 'c']);
  });

  it('skips machines whose card is disabled', () => {
    const a = node('a', { node_provider_id: 'p', logged_in_user: 'me@x.io' });
    const t = bulkTargets([a], {}, 'me@x.io', () => false);
    expect([t.upgrade, t.signout, t.delete].every((list) => list.length === 0)).toBe(true);
  });
});

describe('runLimited', () => {
  it('runs every item, keeps going past failures, and caps concurrency', async () => {
    let running = 0;
    let peak = 0;
    const result = await runLimited(
      [1, 2, 3, 4, 5, 6, 7],
      async (n) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        if (n % 3 === 0) throw new Error(`bad ${n}`);
      },
      3,
    );
    expect(peak).toBe(3);
    expect(result.ok.sort()).toEqual([1, 2, 4, 5, 7]);
    expect(result.failed.map((f) => f.item).sort()).toEqual([3, 6]);
  });

  it('handles an empty list', async () => {
    expect(await runLimited([], async () => undefined)).toEqual({ ok: [], failed: [] });
  });
});

describe('bulkSummary', () => {
  it('names each failed machine with its reason', () => {
    const msg = bulkSummary('Deleted 1 of 2 machines.', {
      ok: [node('a')],
      failed: [{ item: node('b'), error: new Error('timeout') }],
    });
    expect(msg).toContain('Deleted 1 of 2 machines.');
    expect(msg).toContain('b (timeout)');
  });

  it('is just the headline when nothing failed', () => {
    expect(bulkSummary('Upgraded 2 of 2 machines.', { ok: [node('a'), node('b')], failed: [] })).toBe(
      'Upgraded 2 of 2 machines.',
    );
  });
});
