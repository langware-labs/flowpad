/**
 * The terminal bar's quick prompts: a click sends the prompt (and stamps it last-used), Enter in the
 * inline box saves a "Mine" prompt, the session's last prompt is saved — never sent — and delete removes.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Annotation } from '@sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = '56cb3eae-77ff-5727-8d01-08fce10852e0';
const PROJECT = 'c82a1115-2f20-52e0-aa2a-4658898b5873';
const notes = vi.hoisted(() => ({
  prompts: [] as unknown[],
  add: vi.fn(),
  touch: vi.fn(),
  del: vi.fn(),
}));

vi.mock('@src/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: USER, name: 'me' } }) }));
vi.mock('@src/hooks/use-entity-notes', async (orig) => ({
  ...(await orig<typeof import('@src/hooks/use-entity-notes')>()),
  useQuickPrompts: () => notes.prompts,
  addQuickPrompt: notes.add,
  touchQuickPrompt: notes.touch,
  deleteNote: notes.del,
}));

import { QuickPromptsMenu } from '@src/components/notes/QuickPromptsMenu';

const prompt = (content: string) =>
  new Annotation({
    id: crypto.randomUUID(),
    subkind: 'quick_prompt',
    target_type: 'user',
    target_id: USER,
    content,
    data: { color: 'yellow' },
  });

beforeEach(() => {
  notes.prompts = [prompt('Run the tests')];
  vi.clearAllMocks();
});
afterEach(() => cleanup());

async function open(lastPromptText: string | null = null) {
  const onSend = vi.fn();
  render(<QuickPromptsMenu projectId={PROJECT} isActive lastPromptText={lastPromptText} onSend={onSend} />);
  await userEvent.click(screen.getByTestId('quick-prompts-button'));
  return onSend;
}

describe('QuickPromptsMenu', () => {
  it('a click sends the prompt, stamps it last-used and closes the list', async () => {
    const onSend = await open();
    await userEvent.click(screen.getByTestId('quick-prompt-run'));
    expect(onSend).toHaveBeenCalledWith('Run the tests');
    expect(notes.touch).toHaveBeenCalledWith(notes.prompts[0]);
    expect(screen.queryByTestId('quick-prompts-popover')).toBeNull();
  });

  it('Enter in the inline box saves a Mine prompt and sends nothing', async () => {
    const onSend = await open();
    await userEvent.type(screen.getByTestId('quick-prompt-input'), '  Commit it  {Enter}');
    expect(notes.add).toHaveBeenCalledWith('Commit it', { type: 'user', id: USER, name: 'me' });
    expect(onSend).not.toHaveBeenCalled();
    expect((screen.getByTestId('quick-prompt-input') as HTMLInputElement).value).toBe('');
  });

  it("the session's last prompt is saved, not sent — and is not offered once saved", async () => {
    const onSend = await open('Say hi');
    await userEvent.click(screen.getByTestId('quick-prompt-last'));
    expect(notes.add).toHaveBeenCalledWith('Say hi', { type: 'user', id: USER, name: 'me' });
    expect(onSend).not.toHaveBeenCalled();
    cleanup();
    await open('Run the tests');
    expect(screen.queryByTestId('quick-prompt-last')).toBeNull();
  });

  it('delete removes the prompt', async () => {
    await open();
    await userEvent.click(screen.getByTestId('quick-prompt-delete'));
    expect(notes.del).toHaveBeenCalledWith(notes.prompts[0]);
  });
});
