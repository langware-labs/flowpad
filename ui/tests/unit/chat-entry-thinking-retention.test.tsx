import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ChatEntryItem } from '@src/components/lens-viewer/shared/transcript-features/ChatEntryItem';
import type { UnifiedEntry } from '@src/components/lens-viewer/shared/transcript-features/types';

const THINKING =
  'First line of reasoning.\n' +
  'Second line of reasoning.\n' +
  'Third line of reasoning.\n' +
  'Fourth line makes the block collapsible.';

function entry(sessionId: string): UnifiedEntry {
  return {
    id: 'assistant-turn',
    timestamp: '2026-07-28T10:00:00.000Z',
    sessionId,
    parentId: null,
    isSidechain: false,
    role: 'assistant',
    worker: 'codex',
    text: 'Done',
    thinking: THINKING,
    rawEntries: [],
    searchHaystack: '',
  };
}

function renderEntry(sessionId: string) {
  return render(
    <ChatEntryItem
      entry={entry(sessionId)}
      isExpanded={false}
      onToggle={() => undefined}
      isAdvanced
    />,
  );
}

describe('ChatEntryItem thinking expansion retention', () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
  });

  it('restores an expanded thinking block when its chat view remounts', () => {
    const first = renderEntry('thinking-one');
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy();

    first.unmount();
    renderEntry('thinking-two');
    expect(screen.getByRole('button', { name: 'Show more' })).toBeTruthy();

    cleanup();
    renderEntry('thinking-one');
    expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy();
  });
});
