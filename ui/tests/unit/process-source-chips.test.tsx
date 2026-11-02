/**
 * A session's toolbar: one chip per source, but several messages fold into ONE chip with a count
 * that opens their list (newest first). And a message's icon says which way it went.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TypeId, dataManager, type AgenticProcess } from '@sdk';

vi.mock('@src/components/conversation/EntityChip', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ContextEntityChip: ({ typeId }: { typeId: TypeId }) => <span data-testid={`chip-${String(typeId)}`} />,
}));

import { ProcessSourceChips } from '@src/components/terminal/interactive-terminal/ProcessSourceChips';
import { messageDirection, messageIconTag } from '@src/components/conversation/message-direction';

const conv = new TypeId('conversation', '11111111-1111-4111-8111-111111111111');
const msg = (n: number) => new TypeId('flow_message', `2222222${n}-2222-4222-8222-222222222222`);

function proc(context: TypeId[]): AgenticProcess {
  vi.spyOn(dataManager, 'subscribe').mockReturnValue(() => {});
  return { typeId: new TypeId('agentic_process', '33333333-3333-4333-8333-333333333333'), sharedContextEntities: context } as unknown as AgenticProcess;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ProcessSourceChips', () => {
  it('shows one message as its own chip', () => {
    render(<ProcessSourceChips process={proc([conv, msg(1)])} />);
    expect(screen.getByTestId(`chip-${String(conv)}`)).toBeTruthy();
    expect(screen.getByTestId(`chip-${String(msg(1))}`)).toBeTruthy();
    expect(screen.queryByTestId('process-source-messages')).toBeNull();
  });

  it('folds several messages into one chip with a count that lists them newest first', () => {
    render(<ProcessSourceChips process={proc([conv, msg(1), msg(2), msg(3)])} />);
    expect(screen.getByTestId(`chip-${String(conv)}`)).toBeTruthy();
    expect(screen.queryByTestId(`chip-${String(msg(1))}`)).toBeNull();
    expect(screen.getByTestId('process-source-messages-count').textContent).toBe('3');

    const trigger = screen.getByTestId('process-source-messages');
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const listed = screen.getAllByTestId(/^chip-flow_message-/).map((el) => el.dataset.testid);
    expect(listed).toEqual([3, 2, 1].map((n) => `chip-${String(msg(n))}`));
  });
});

describe('message direction', () => {
  it('is sent when this user wrote it, received otherwise, unknown without both ids', () => {
    expect(messageDirection({ sender_id: 'me' }, 'me')).toBe('sent');
    expect(messageDirection({ sender_id: 'ami' }, 'me')).toBe('received');
    expect(messageDirection({ sender_id: 'me' }, null)).toBeNull();
    vi.spyOn(dataManager, 'iconForType').mockReturnValue('flowpad.message');
    expect(messageIconTag('sent')).toBe('flowpad.message.sent');
    expect(messageIconTag('received')).toBe('flowpad.message.received');
    expect(messageIconTag(null)).toBe('flowpad.message');
  });
});
