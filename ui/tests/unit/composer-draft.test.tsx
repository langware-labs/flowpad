/**
 * The composer's draft: what is typed is stored as the conversation's draft and is there when the
 * composer mounts again — per composer, so a thread's draft never shows in another's box.
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComposerDraft, ComposerDraftKey } from '@src/components/conversation/flow-message-drafts';

const rows = new Map<string, ComposerDraft>();
const puts: string[] = [];
const idOf = (key: ComposerDraftKey) => `${key.conversationId}:${key.threadId ?? ''}`;

vi.mock('@src/components/conversation/flow-message-drafts', async (actual) => ({
  ...(await actual<typeof import('@src/components/conversation/flow-message-drafts')>()),
  loadComposerDraft: async (key: ComposerDraftKey) =>
    rows.has(idOf(key)) ? { row: { id: idOf(key) }, draft: rows.get(idOf(key)) } : null,
  putComposerDraft: async (key: ComposerDraftKey, draft: ComposerDraft) => {
    puts.push(draft.text);
    if (!draft.text.trim() && draft.files.length === 0) {
      rows.delete(idOf(key));
      return null;
    }
    rows.set(idOf(key), draft);
    return { id: idOf(key) };
  },
}));

import { useComposerDraft } from '@src/components/conversation/useComposerDraft';

const holding = (text: string): ComposerDraft => ({
  text,
  files: [],
  assetRefs: [],
  replyToId: null,
  taskIt: false,
  promptCall: false,
});
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

function mount(key: ComposerDraftKey, text = '') {
  const restored: ComposerDraft[] = [];
  const hook = renderHook(({ held }) => useComposerDraft(key, held, (saved) => restored.push(saved)), {
    initialProps: { held: holding(text) },
  });
  return { ...hook, restored, type: (next: string) => hook.rerender({ held: holding(next) }) };
}

describe('useComposerDraft', () => {
  beforeEach(() => {
    rows.clear();
    puts.length = 0;
  });

  it('stores what is typed and hands it back to the next mount of the same composer only', async () => {
    const main = { conversationId: 'c1', threadId: null };
    const first = mount(main);
    await settle();
    first.type('hel');
    first.type('hello');
    // Leaving mid-typing stores what is held, without waiting for the pause.
    first.unmount();
    await settle();
    expect(puts).toEqual(['hello']);

    const again = mount(main);
    await settle();
    expect(again.restored.map((d) => d.text)).toEqual(['hello']);
    // Handing it back is not an edit: the box still renders empty for a moment, and that is never stored.
    expect(rows.get('c1:')?.text).toBe('hello');
    expect(puts).toEqual(['hello']);
    const thread = mount({ conversationId: 'c1', threadId: 't1' });
    await settle();
    expect(thread.restored).toEqual([]);
  });

  it('send takes the stored row; clearing the box leaves no draft behind', async () => {
    const main = { conversationId: 'c1', threadId: null };
    const composer = mount(main);
    await settle();
    composer.type('ship it');
    let row: unknown;
    await act(async () => void (row = await composer.result.current.flush()));
    expect(row).toEqual({ id: 'c1:' });

    composer.type('');
    await act(async () => void (await composer.result.current.flush()));
    expect(rows.size).toBe(0);
  });

  it('a composer that keeps no draft stores nothing', async () => {
    const composer = renderHook(() => useComposerDraft(null, holding('typed'), () => {}));
    await settle();
    composer.unmount();
    await settle();
    expect(puts).toEqual([]);
  });
});
