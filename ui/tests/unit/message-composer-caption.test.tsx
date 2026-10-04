import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sdk/entities/notifications', () => ({
  sendReply: vi.fn(() => Promise.resolve({ id: 'm1' })),
  sendToChannel: vi.fn(),
}));
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
// The annotator stands in as "the user typed this caption and pressed Enter".
vi.mock('@src/components/image-annotator/annotate-files', () => ({
  annotateImageFiles: vi.fn((files: File[]) => Promise.resolve({ files, caption: 'see the red arrow' })),
}));

import { sendReply } from '@sdk/entities/notifications';
import { annotateImageFiles } from '@src/components/image-annotator/annotate-files';
import { MessageComposer } from '@src/components/conversation/MessageComposer';

const CONV = 'c0c0c0c0-0000-4000-8000-000000000008';

function pasteImage(box: HTMLElement, text = '') {
  const image = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });
  fireEvent.paste(box, {
    clipboardData: {
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }],
      files: [image],
      getData: (type: string) => (type === 'text/plain' ? text : ''),
    },
  });
}

/** The caption typed under a pasted image IS the message. */
describe('MessageComposer — image caption', () => {
  afterEach(() => {
    cleanup();
    vi.mocked(sendReply).mockClear();
  });

  it('with nothing typed yet, the image and its caption are sent at once', async () => {
    render(<MessageComposer conversationId={CONV} />);
    pasteImage(screen.getByPlaceholderText('Reply to sender…'));
    await waitFor(() => expect(sendReply).toHaveBeenCalledTimes(1));
    const [, body, files] = vi.mocked(sendReply).mock.calls[0];
    expect(body).toBe('see the red arrow');
    expect(files?.map((f) => f.name)).toEqual(['shot.png']);
  });

  it('with a reply already typed, the caption is inserted at the caret and nothing is sent', async () => {
    render(<MessageComposer conversationId={CONV} />);
    const box = screen.getByPlaceholderText<HTMLTextAreaElement>('Reply to sender…');
    fireEvent.change(box, { target: { value: 'before  after' } });
    box.selectionStart = box.selectionEnd = 7;
    pasteImage(box);
    await waitFor(() => expect(box.value).toBe('before see the red arrow after'));
    expect(screen.getByText('shot.png')).toBeTruthy();
    expect(sendReply).not.toHaveBeenCalled();
  });

  it('text pasted with the image prefills the caption and is not inserted a second time', async () => {
    vi.mocked(annotateImageFiles).mockImplementationOnce((files, opts) =>
      Promise.resolve({ files, caption: opts?.initialCaption ?? '' }),
    );
    render(<MessageComposer conversationId={CONV} />);
    const box = screen.getByPlaceholderText<HTMLTextAreaElement>('Reply to sender…');
    fireEvent.change(box, { target: { value: 'x' } });
    pasteImage(box, 'copied text');
    expect(vi.mocked(annotateImageFiles)).toHaveBeenLastCalledWith(expect.any(Array), {
      initialCaption: 'copied text',
    });
    await waitFor(() => expect(box.value).toBe('xcopied text'));
  });
});
