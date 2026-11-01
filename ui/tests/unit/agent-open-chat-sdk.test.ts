/**
 * `Agent.openChat` / `newChat` — which chat an opener lands on. The page's `<flowpad-agent>` and the
 * app's launcher share `lastChat`, so both open the same chat.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataManager } from '@sdk/APIEntity';
import { Agent } from '@sdk/entities/agent';

const AGENT = 'ab32dd2f-d5c1-4493-9713-66bac77da6cf';
const FRESH = '5f0c8e2a-7b1d-4c3e-9a2f-6d4b8e1c0a97';
const agent = () => new Agent({ id: AGENT, name: 'scrooge' } as never);
const proc = (id: string, last_active_at: string) => ({ id, last_active_at, drainQueue: vi.fn(async () => {}) });

afterEach(() => vi.restoreAllMocks());

describe('Agent.openChat', () => {
  it('opens the most recent chat this agent had in the project', async () => {
    const query = vi
      .spyOn(dataManager, 'query')
      .mockResolvedValue([proc('old', '2026-10-01T00:00:00Z'), proc('new', '2026-10-28T00:00:00Z')] as never);
    const use = vi.spyOn(Agent.prototype, 'use');

    const chat = await agent().openChat('p-1');

    expect(chat.id).toBe('new');
    expect(use).not.toHaveBeenCalled();
    const ops = (query.mock.calls[0][0] as { query: { match: { operands: unknown[] } } }).query.match.operands;
    expect(ops).toContainEqual({ op: '$EQ', operands: ['project_id', 'p-1'] });
    expect(ops).toContainEqual({ op: '$EQ', operands: ['target_typeid_str', `agent-${AGENT}`] });
  });

  it('starts a new chat when there is none', async () => {
    vi.spyOn(dataManager, 'query').mockResolvedValue([] as never);
    const fresh = proc(FRESH, '');
    const use = vi.spyOn(Agent.prototype, 'use').mockResolvedValue({ process_id: FRESH } as never);
    vi.spyOn(dataManager, 'getByTypeId').mockResolvedValue(fresh as never);

    const chat = await agent().openChat('p-1');

    expect(chat).toBe(fresh);
    expect(use).toHaveBeenCalledWith('p-1', true);
    expect(fresh.drainQueue).toHaveBeenCalled(); // the auto prompt runs as turn 1
  });
});

describe('Agent.newChat', () => {
  it('always starts one, even when a last chat exists', async () => {
    const query = vi.spyOn(dataManager, 'query').mockResolvedValue([proc('old', '2026-10-01T00:00:00Z')] as never);
    vi.spyOn(Agent.prototype, 'use').mockResolvedValue({ process_id: FRESH } as never);
    vi.spyOn(dataManager, 'getByTypeId').mockResolvedValue(proc(FRESH, '') as never);

    expect((await agent().newChat('p-1')).id).toBe(FRESH);
    expect(query).not.toHaveBeenCalled();
  });
});
