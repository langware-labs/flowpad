/**
 * The classification table: a run's proposal per conversation. Nothing is applied until a person says so;
 * a rejected row stays out of Apply all; the tag tree's changes are drawn on the tree.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const TAGS: Record<string, string[]> = { ma: [], mb: ['stream_inbox.billing'], mc: ['stream_inbox.urgent'] };
const row = (id: string, before: string[], proposed: string[], action: string, more = {}) => ({
  conversation_id: `c${id}`, message_id: `m${id}`, title: `Conversation ${id}`, before, proposed, action, reason: `because ${id}`, ...more,
});
const VALUE = {
  root: 'stream_inbox',
  conversations: [
    row('a', [], ['stream_inbox.refund'], 'apply', { asked: { tag: 'stream_inbox.money-back', meaning: 'Wants a charge returned', answer: 'use_existing', use: 'stream_inbox.refund' } }),
    row('b', ['stream_inbox.billing'], ['stream_inbox.billing'], 'keep'),
    row('c', ['stream_inbox.urgent'], [], 'remove'),
  ],
  tree_changes: [
    { op: 'added', tag: 'stream_inbox.refund', meaning: 'Asks for money back', reason: 'new' },
    { op: 'updated', tag: 'stream_inbox.urgent', was: 'Needs an answer today', meaning: 'An outage or a deadline', reason: 'sharper' },
    { op: 'moved', tag: 'stream_inbox.sales.intro', was: 'stream_inbox.intro', reason: 'belongs to sales' },
    { op: 'removed', tag: 'stream_inbox.demo', merged_into: 'stream_inbox.sales.intro', reason: 'same as intro' },
  ],
};
const { classificationRun, applyStreamInboxClassification } = vi.hoisted(() => ({
  classificationRun: vi.fn(),
  applyStreamInboxClassification: vi.fn(),
}));
vi.mock('@sdk', () => ({
  FlowMessage: { type: 'flow_message', classificationRun, applyStreamInboxClassification },
  Conversation: { type: 'conversation' },
  tagIsWithin: (tag: string, root: string) => tag === root || tag.startsWith(`${root}.`),
  TypeId: class {
    constructor(
      public type: string,
      public id: string,
    ) {}
  },
}));
vi.mock('@src/hooks/entity-hooks/useEntity', () => ({
  useEntity: (typeId: { id: string }) => ({ data: { id: typeId.id, title: `Conversation ${typeId.id}`, tags: TAGS[typeId.id] ?? [] } }),
}));
vi.mock('@src/notifications', () => ({ notify: { error: vi.fn() } }));
vi.mock('@src/navigation/useDockNavigation', () => ({ useDockNavigation: () => ({ navigation: { openDock: vi.fn() }, currentDock: null }) }));
vi.mock('@src/components/tags/MessageTags', () => ({
  MessageTags: ({ message }: { message: { tags: string[] } }) => <span>{message.tags.join(',')}</span>,
  useTagColors: () => new Map(),
  useTagDefinitions: () => ['stream_inbox.billing', 'stream_inbox.urgent', 'stream_inbox.intro', 'stream_inbox.demo'].map((name) => ({ name })),
  tagChipStyle: () => undefined,
  treeRows: (names: string[], root: string) => names.sort().map((name) => ({ name, depth: name.split('.').length - root.split('.').length - 1 })),
}));

import { ClassifyDialog } from '@src/components/tags/ClassifyTable';

const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ClassifyDialog callId="run-1" onClose={() => undefined} />
    </QueryClientProvider>,
  );
const cell = (id: string, testid: string) => screen.getByTestId(`classify-row-c${id}`).querySelector(`[data-testid=${testid}]`);

describe('ClassifyDialog', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('waits on the run, then applies only what the person applies', async () => {
    classificationRun.mockResolvedValue({ call_id: 'run-1', state: 'completed', input: { conversations: ['ca', 'cb', 'cc'] }, result: { exit_code: 0, detail: '', value: VALUE } });
    applyStreamInboxClassification.mockResolvedValue({ applied: [], failed: {}, tree: {} });
    show();
    await waitFor(() => expect(screen.getByTestId('classify-summary').textContent).toBe('3 classified · 2 would change · 1 applied'));
    expect(cell('a', 'classify-row-new')!.textContent).toContain('new tag');
    expect(cell('b', 'classify-row-apply')).toBeNull(); // already carries the proposal
    expect(cell('c', 'classify-row-new')!.textContent).toContain('no tag fits');

    fireEvent.click(cell('a', 'classify-row-why')!);
    expect(screen.getByTestId('classify-row-trace').textContent).toContain('because a');
    expect(screen.getByTestId('classify-row-trace').textContent).toContain('Wants a charge returned');

    fireEvent.click(cell('a', 'classify-row-apply')!);
    await waitFor(() => expect(applyStreamInboxClassification).toHaveBeenCalledWith(VALUE, { conversations: ['ca'], tree: false }));

    fireEvent.click(cell('c', 'classify-row-reject')!);
    expect(cell('c', 'classify-row-new')!.textContent).toContain('rejected');
    fireEvent.click(screen.getByTestId('classify-apply-all'));
    await waitFor(() => expect(applyStreamInboxClassification).toHaveBeenLastCalledWith(VALUE, { conversations: ['ca'], tree: true }));
  });

  it('draws every tag change on the tree, where it happened', async () => {
    classificationRun.mockResolvedValue({ call_id: 'run-1', state: 'completed', input: null, result: { exit_code: 0, detail: '', value: VALUE } });
    show();
    fireEvent.click(await screen.findByTestId('classify-tree-changes'));
    const change = (name: string) => screen.getByTestId(`classify-tree-row-${name}`).getAttribute('data-change');
    expect(['stream_inbox.refund', 'stream_inbox.urgent', 'stream_inbox.sales.intro', 'stream_inbox.demo'].map(change)).toEqual(['added', 'updated', 'moved', 'removed']);
    expect(screen.queryByTestId('classify-tree-row-stream_inbox.intro')).toBeNull(); // the moved tag's old place is gone
    expect(screen.getByTestId('classify-tree-panel').textContent).toContain('1 added · 1 updated · 1 moved · 1 removed');
  });

  it('says why when the run did not finish, and shows the conversations it was reading', async () => {
    classificationRun.mockResolvedValue({ call_id: 'run-1', state: 'failed', input: { conversations: ['ca'] }, result: null, error: 'The agent stopped.' });
    show();
    await waitFor(() => expect(screen.getByTestId('classify-error').textContent).toBe('The agent stopped.'));
    expect(screen.getByTestId('classify-row-ca').textContent).toContain('Conversation ca');
  });
});
