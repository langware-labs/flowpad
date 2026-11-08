import { render } from '@testing-library/react';
import { AgenticProcess } from '@sdk';
import { ChatHistoryRow } from '@src/components/chats-navigator/ChatHistoryRow';
import { useEntity } from '@src/hooks/entity-hooks/useEntity';
import type { WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';
import { describe, expect, it, vi } from 'vitest';

/**
 * Perf hunt 2026-11-07 (B1): every row asked the backend to watch its process, and the
 * navigator remounts on each process <-> doc switch — ~40 watch + ~40 unwatch POSTs per switch.
 * The list's live query already brings each member's changes (a rename reaches the row, proven
 * in a browser), so a row only reads the local cache.
 */
vi.mock('@src/hooks/entity-hooks/useEntity', () => ({ useEntity: vi.fn(() => ({ data: null })) }));

describe('ChatHistoryRow', () => {
  it('reads its process from the cache without a backend watch', () => {
    const id = 'c9db45fa-2b89-45ec-b54c-53fbdc32c24e';
    vi.spyOn(AgenticProcess, 'getByIdFromCache').mockReturnValue({ id, name: 'x' } as never);
    const entry = { worker_type: 'claude', worker_id: 'w', agentic_process_id: id } as WorkerHistoryEntry;
    render(
      <ChatHistoryRow entry={entry} selected={false} hasOpenTab onSelect={vi.fn()} onToggleFavorite={vi.fn()} onDelete={vi.fn()} />,
    );
    const options = vi.mocked(useEntity).mock.calls.at(-1)?.[1];
    expect(options).toMatchObject({ enabled: true });
    expect(options).not.toHaveProperty('watch', true);
  });
});
