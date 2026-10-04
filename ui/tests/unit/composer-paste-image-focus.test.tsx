import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sdk/entities/notifications', () => ({ sendReply: vi.fn(), sendToChannel: vi.fn() }));
vi.mock('@src/hooks/use-cloud-login-gate', () => ({ useCloudLoginGate: () => () => Promise.resolve({ ok: true }) }));
vi.mock('@src/components/conversation/useLocalUser', () => ({
  useLocalUser: () => ({ localUser: { id: 'me', name: 'Me' }, updateName: vi.fn() }),
}));
vi.mock('@src/components/asset-manager/AssetManagerPopover', () => ({
  AssetManagerPopover: ({ trigger }: { trigger: React.ReactNode }) => <>{trigger}</>,
}));
vi.mock('@src/components/conversation/EmojiPicker', () => ({
  EmojiPicker: ({ trigger }: { trigger: React.ReactNode }) => <>{trigger}</>,
}));
vi.mock('@src/components/conversation/AttachMenu', () => ({
  AssetRefChips: () => null,
  useAssetRefSelection: () => ({ selectedTypeIds: [] }),
}));
// The annotator is a dialog: while it is up the reply box loses focus, and on close it hands
// focus to <body>. Model that — blur the box before resolving, as the real dialog does.
vi.mock('@src/components/image-annotator/annotate-files', () => ({
  annotateImageFiles: (f: File[]) => {
    (document.activeElement as HTMLElement | null)?.blur();
    return Promise.resolve({ files: f, caption: '' });
  },
}));

import { MessageComposer } from '@src/components/conversation/MessageComposer';

/** After pasting an image (and attaching it from the annotator) the next keystroke is the reply. */
describe('MessageComposer — paste an image, keep typing', () => {
  afterEach(() => cleanup());

  it('puts the cursor back in the reply box once the image is attached', async () => {
    render(<MessageComposer conversationId="c0c0c0c0-0000-4000-8000-000000000006" />);
    const box = screen.getByPlaceholderText('Reply to sender…');
    box.focus();
    const image = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });
    fireEvent.paste(box, {
      clipboardData: {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }],
        files: [image],
        getData: () => '',
      },
    });
    await waitFor(() => expect(screen.getByText('shot.png')).toBeTruthy());
    await waitFor(() => expect(document.activeElement).toBe(box));
  });
});
