/**
 * A deployment's threads: one row per conversation — a whole phone call is one — the active ones
 * saying what is happening in them; selecting one only navigates (URL-first), and the thread's events
 * read in the order they happened.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeploymentThread } from '@sdk';

vi.mock('@src/hooks/entity-hooks', () => ({ useEntitiesQuery: () => ({ data: [] }) }));
vi.mock('@src/components/data-sources/use-source-specs', () => ({
  sourcesQuery: {},
  useSourceSpecs: () => ({ specFor: () => undefined }),
}));

import { DeploymentThreads } from '@src/components/assets/editor/agent-profile/deployment/DeploymentThreads';

function thread(id: string, extra: Partial<DeploymentThread> = {}): DeploymentThread {
  return {
    conversation_id: id,
    title: `Thread ${id}`,
    who: 'Yossi',
    channel: 'voice',
    data_source_id: 'ds-1',
    process_id: `p-${id}`,
    status: 'idle',
    started_at: '2026-09-24T10:00:00Z',
    last_at: '2026-09-24T10:05:00Z',
    last_text: 'the last line',
    messages: 4,
    turns: 1,
    ...extra,
  };
}

afterEach(cleanup);

describe('deployment threads', () => {
  it('lists one row per thread and says what is happening in the active ones', () => {
    render(
      <DeploymentThreads
        threads={[thread('call', { status: 'live', title: 'Call with +97250' }), thread('chat', { status: 'working' }), thread('old', { status: 'ended' })]}
        selected="call"
        onSelect={() => undefined}
      />,
    );
    expect(screen.getByTestId('deployment-thread-call')).toHaveTextContent('Call with +97250');
    expect(screen.getByTestId('deployment-thread-call')).toHaveAttribute('data-selected', 'true');
    expect(screen.getByTestId('thread-status-live')).toHaveTextContent('Live call');
    expect(screen.getByTestId('thread-status-working')).toHaveTextContent('Working');
    expect(screen.getByTestId('thread-status-ended')).toHaveTextContent('Ended');
  });

  it('selecting a thread hands it to the caller — nothing else', () => {
    const onSelect = vi.fn();
    render(<DeploymentThreads threads={[thread('a'), thread('b')]} selected="a" onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId('deployment-thread-b'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect((onSelect.mock.calls[0][0] as DeploymentThread).conversation_id).toBe('b');
  });

  it('with no conversations it says how one starts', () => {
    render(<DeploymentThreads threads={[]} selected={null} onSelect={() => undefined} />);
    expect(screen.getByTestId('deployment-threads-empty')).toBeInTheDocument();
  });
});

