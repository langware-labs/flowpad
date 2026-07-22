/**
 * The Journey interface in the TS SDK — `launch / restart / advance / progress /
 * history` + static `resume`. Each is a thin call over apiClient; these assert
 * the exact path + payload and that the JOURNAL is what comes back (there is no
 * separate progress object).
 *
 * Spies on the shared apiClient instance rather than vi.mock()ing the module:
 * the SDK entity imports it relatively (`../client`), so a specifier-based mock
 * wouldn't intercept it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import apiClient from '@sdk/client';
import { Journey, JourneyJournal } from '@sdk';

const JID = '5eaa7e57-1111-4222-8333-444455556666';
const JOURNAL_ID = '3f1c9b6e-2222-4333-8444-555566667777';
const BASE = `/api/v1/journeys/${JID}`;

const journalPayload = {
  id: JOURNAL_ID, journey_id: JID, user_id: 'u-1', status: 'launched',
  cursor: 's2', total_steps: 3, steps_left: 2,
  entries: [{ node_id: 's1', event: 'done', at: '2026-07-22T10:00:00Z' }],
};

let get: ReturnType<typeof vi.spyOn>;
let post: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  get = vi.spyOn(apiClient, 'get').mockResolvedValue(journalPayload as never);
  post = vi.spyOn(apiClient, 'post').mockResolvedValue(journalPayload as never);
});
afterEach(() => vi.restoreAllMocks());

const journey = () => new Journey({ id: JID, type: 'journey' });

describe('Journey interface → apiClient', () => {
  it('progress() GETs /progress and returns the journal', async () => {
    const out = await journey().progress();
    expect(get).toHaveBeenCalledWith(`${BASE}/progress`);
    expect(out?.cursor).toBe('s2');
    expect(out?.steps_left).toBe(2);
    expect(out?.status).toBe('launched');
  });

  it('launch() POSTs /launch', async () => {
    await journey().launch();
    expect(post).toHaveBeenCalledWith(`${BASE}/launch`);
  });

  it('restart() POSTs /restart', async () => {
    await journey().restart();
    expect(post).toHaveBeenCalledWith(`${BASE}/restart`);
  });

  it('advance() POSTs node_id with a default event of done', async () => {
    await journey().advance('s2');
    expect(post).toHaveBeenCalledWith(`${BASE}/advance`, { node_id: 's2', event: 'done' });
  });

  it('advance() carries an explicit skipped event', async () => {
    await journey().advance('s2', 'skipped');
    expect(post).toHaveBeenCalledWith(`${BASE}/advance`, { node_id: 's2', event: 'skipped' });
  });

  it('history() GETs /history', async () => {
    get.mockResolvedValue([journalPayload] as never);
    const rows = await journey().history();
    expect(get).toHaveBeenCalledWith(`${BASE}/history`);
    expect(rows).toHaveLength(1);
  });

  it('static resume() POSTs the journal id to the collection route', async () => {
    await Journey.resume(JOURNAL_ID);
    expect(post).toHaveBeenCalledWith('/api/v1/journeys/resume', { journal_id: JOURNAL_ID });
  });

  it('opens in the journey viewer, not the markdown editor', () => {
    expect(journey().dockPointer.pointer).toContain('editor/journey/');
  });
});

describe('JourneyJournal', () => {
  const withStatus = (status: string) =>
    new JourneyJournal({ id: JOURNAL_ID, type: 'journey_journal', status: status as never });

  it('isActive covers exactly the non-terminal statuses', () => {
    expect(withStatus('new').isActive).toBe(true);
    expect(withStatus('launched').isActive).toBe(true);
    expect(withStatus('complete').isActive).toBe(false);
    expect(withStatus('restarted').isActive).toBe(false);
  });
});
