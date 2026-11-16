/**
 * A chat opens on the newest page of its transcript, not the whole of it: a long one ran to
 * 9.2 MB on prod and the pane showed nothing until every byte arrived. "Load earlier messages"
 * asks for one more page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataManager } from '../../../ts_sdk/src/APIEntity';
import { AgenticProcess } from '../../../ts_sdk/src/process/agentic-process';

const PROCESS_ID = '00000000-0000-4000-8000-0000000b4b40';

describe('chat history paging', () => {
  let call: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    call = vi.spyOn(dataManager, 'callAction').mockResolvedValue({
      history: [],
      count: 200,
      total: 450,
      session_id: 's',
      use_worker_history: true,
    } as never);
  });
  afterEach(() => call.mockRestore());

  const limitsAsked = () => call.mock.calls.map(([action]) => (action as { queryParameters?: { limit?: number } }).queryParameters?.limit);

  it('loads the newest page, and one more page on request', async () => {
    const process = new AgenticProcess({ id: PROCESS_ID });
    await process.loadHistory();
    expect(limitsAsked()).toEqual([AgenticProcess.HISTORY_PAGE]);
    expect(process.hasEarlierHistory).toBe(true);

    await process.loadEarlierHistory();
    expect(limitsAsked()).toEqual([AgenticProcess.HISTORY_PAGE, 2 * AgenticProcess.HISTORY_PAGE]);
  });

  it('reads the whole transcript for the user-message list', async () => {
    await new AgenticProcess({ id: `${PROCESS_ID.slice(0, -1)}1` }).loadHistory({ onlyUserMessages: true });
    expect(limitsAsked()).toEqual([undefined]);
  });
});
