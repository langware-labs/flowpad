/**
 * The classify window while a run is at work. Nobody waits in it: it says the result comes as an Automations
 * message, shows the run's one line, the conversations only behind Details, and closes when the proposal is in.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { classificationRun } = vi.hoisted(() => ({ classificationRun: vi.fn() }));
vi.mock('@sdk', () => ({
  FlowMessage: { type: 'flow_message', classificationRun },
  Conversation: { type: 'conversation' },
  TypeId: class {
    constructor(
      public type: string,
      public id: string,
    ) {}
  },
}));
vi.mock('@src/hooks/entity-hooks/useEntity', () => ({
  useEntity: (typeId: { id: string }) => ({ data: { id: typeId.id, title: `Conversation ${typeId.id}` } }),
}));
vi.mock('@src/notifications', () => ({ notify: { error: vi.fn() } }));
vi.mock('@src/navigation/useDockNavigation', () => ({ useDockNavigation: () => ({ navigation: { openDock: vi.fn() }, currentDock: null }) }));
vi.mock('@src/components/graph-view/icons/iconRegistry', () => ({ iconForType: () => () => null }));
vi.mock('@src/components/conversation/channel-attribution', () => ({
  SourceChip: ({ attribution }: { attribution: { kind: string } }) => <span data-testid="source-chip">{attribution.kind}</span>,
  useChannelAttribution: () => ({ attributionFor: (origin: { kind: string }) => origin }),
}));

import { ClassifyDialog } from '@src/components/tags/ClassifyTable';

const onClose = vi.fn();
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ClassifyDialog callId="run-1" onClose={onClose} />
    </QueryClientProvider>,
  );
const run = (more: object) => ({ call_id: 'run-1', block: 'stream-inbox-classifier', created_at: new Date().toISOString(), input: { conversations: ['ca', 'cb'] }, result: null, error: null, ...more });

describe('ClassifyDialog', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('says the result comes as an Automations message; the conversations show only behind Details', async () => {
    classificationRun.mockResolvedValue(run({ state: 'running' }));
    show();
    await waitFor(() => expect(screen.getByTestId('classify-run-line').textContent).toContain('Running · 2 conversations'));
    expect(screen.getByTestId('classify-notice').textContent).toContain('Classification is in progress');
    expect(screen.getByTestId('source-chip').textContent).toBe('automations');
    expect(screen.queryByTestId('classify-table')).toBeNull();
    fireEvent.click(screen.getByTestId('classify-details'));
    expect(screen.getByTestId('classify-row-ca').textContent).toContain('Classifying');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes itself once the run handed its proposal in', async () => {
    classificationRun.mockResolvedValue(run({ state: 'completed', result: { exit_code: 0, detail: '', value: { conversations: [] } } }));
    show();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('says why when the run did not finish, and stays open', async () => {
    classificationRun.mockResolvedValue(run({ state: 'failed', error: 'The agent stopped.' }));
    show();
    await waitFor(() => expect(screen.getByTestId('classify-error').textContent).toBe('The agent stopped.'));
    expect(screen.getByTestId('classify-run-line').textContent).toContain('Stopped');
    expect(onClose).not.toHaveBeenCalled();
  });
});
