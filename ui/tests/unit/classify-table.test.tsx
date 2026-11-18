/**
 * The mass classification table: one dry run per message; Apply only where the new tag is not on the
 * message yet; ticked rows apply together; a failed call says why.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const MESSAGES: Record<string, { tags: string[]; text: string }> = {
  a: { tags: ['inbox.billing', 'inbox.urgent'], text: 'charged twice' },
  b: { tags: ['inbox.refund'], text: 'money back' },
  c: { tags: [], text: 'export broke' },
};
const { classifyById, applyClassification } = vi.hoisted(() => ({ classifyById: vi.fn(), applyClassification: vi.fn() }));
vi.mock('@sdk', () => ({
  FlowMessage: { type: 'flow_message', classifyById, applyClassification },
  TypeId: class {
    constructor(
      public type: string,
      public id: string,
    ) {}
  },
}));
vi.mock('@sdk/models/MessageEnvelope', () => ({ profileLabel: () => '' }));
vi.mock('@src/hooks/entity-hooks/useEntity', () => ({
  useEntity: (typeId: { id: string }) => ({ data: { id: typeId.id, sender_name: typeId.id, ...MESSAGES[typeId.id] } }),
}));
vi.mock('@src/components/tags/MessageTags', () => ({ useTagColors: () => new Map(), tagChipStyle: () => undefined }));
vi.mock('@src/components/value-viewer/KindValue', () => ({
  KindValue: ({ kind }: { kind: string }) => <div data-testid="classify-row-run">{kind}</div>,
}));

import { ClassifyDialog } from '@src/components/tags/ClassifyTable';

const landed = (tag: string) => ({ exit_code: 0, detail: '', value: { tag, confidence: 0.81 }, run: { request: {} } });

describe('ClassifyDialog', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('classifies each message, offers Apply only where the tag would change, and applies ticked rows', async () => {
    classifyById.mockImplementation((id: string) =>
      id === 'c' ? Promise.reject(new Error('The decision API did not answer')) : Promise.resolve(landed('inbox.refund')),
    );
    applyClassification.mockResolvedValue(undefined);
    render(<ClassifyDialog messageIds={['a', 'b', 'c']} onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('classify-summary').textContent).toBe('3 classified · 1 would change · 1 failed'));
    expect(classifyById).toHaveBeenCalledTimes(3);
    const row = (id: string) => screen.getByTestId(`classify-row-${id}`);
    expect(row('a').querySelector('[data-testid=classify-row-apply]')).not.toBeNull();
    expect(row('b').querySelector('[data-testid=classify-row-apply]')).toBeNull(); // already refund
    expect(row('c').textContent).toContain('The decision API did not answer');

    fireEvent.click(row('a').querySelector('[data-testid=classify-row-why]')!);
    expect(screen.getByTestId('classify-row-run').textContent).toBe('decision.run');

    fireEvent.click(row('a').querySelector('[role=checkbox]')!);
    fireEvent.click(row('b').querySelector('[role=checkbox]')!);
    fireEvent.click(screen.getByTestId('classify-selection-apply'));
    await waitFor(() => expect(screen.getByTestId('classify-summary').textContent).toBe('1 applied · no automation started'));
    expect(applyClassification.mock.calls).toEqual([['a', 'inbox.refund']]);
  });
});
