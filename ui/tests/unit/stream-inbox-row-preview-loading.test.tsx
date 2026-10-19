import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Conversation, dataManager, FlowMessage, type TypeId } from '@sdk';

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: vi.fn() }, currentDock: null }),
}));

import { TooltipProvider } from '@radix-ui/react-tooltip';
import { ConversationListRow } from '@src/components/stream-inbox-view/StreamInboxView';

const CONV_ID = '0d1f7c2e-5a4b-4c3d-9e8f-1a2b3c4d5e6f';
const OLD_ID = '5b0f6f1e-3c1a-4c55-9a51-3a0f7f0d6a11';
const NEW_ID = '8c2d4b7a-1e9f-4b3c-8d6e-2f4a5b6c7d81';

const pointers = (...ids: string[]) =>
  JSON.stringify(ids.map((id, i) => ({ typeid: `flow_message-${id}`, ts: `2026-10-15T08:0${i}:00+00:00` })));

const conversation = (...ids: string[]) =>
  new Conversation({ id: CONV_ID, title: 'FLOWPAD-2246', message_ids: pointers(...ids), message_count: ids.length });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// A row IS its conversation: a new message moving its latest pointer must not unmount it while that
// message is still being fetched (the "Check for new messages" flicker).
describe('ConversationListRow while a newer latest message loads', () => {
  it('stays mounted with the previous preview, then shows the new one', async () => {
    const old = new FlowMessage({ id: OLD_ID, conversation_id: CONV_ID, text: 'old preview', sender_name: 'Gadi' });
    const fresh = new FlowMessage({ id: NEW_ID, conversation_id: CONV_ID, text: 'new preview', sender_name: 'Gadi' });
    let releaseNew!: (m: FlowMessage) => void;
    const newFetch = new Promise<FlowMessage>((done) => (releaseNew = done));
    vi.spyOn(dataManager, 'getByTypeIdFromCache').mockImplementation(((t: TypeId) => (t.id === OLD_ID ? old : null)) as never);
    vi.spyOn(dataManager, 'subscribe').mockReturnValue(() => {});
    vi.spyOn(dataManager, 'getByTypeId').mockImplementation((async (t: TypeId) => (t.id === NEW_ID ? newFetch : null)) as never);

    const props = {
      isFocused: false,
      onArchive: vi.fn(),
      onUnarchive: vi.fn(),
      onToggleRead: vi.fn(),
      onRequestDelete: vi.fn(),
      cloudUserId: null,
      onVisibilityChange: vi.fn(),
      attributionFor: () => null,
      refSetter: () => {},
    };
    const view = render(<ConversationListRow {...props} conv={conversation(OLD_ID)} />, { wrapper: TooltipProvider });
    expect(await screen.findByText(/old preview/)).toBeTruthy();

    view.rerender(<ConversationListRow {...props} conv={conversation(OLD_ID, NEW_ID)} />);
    expect(screen.getByText(/old preview/)).toBeTruthy();

    await act(async () => releaseNew(fresh));
    expect(await screen.findByText(/new preview/)).toBeTruthy();
    expect(screen.queryByText(/old preview/)).toBeNull();
  });
});
