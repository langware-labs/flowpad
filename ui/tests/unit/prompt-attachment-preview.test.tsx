import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TypeId } from '@sdk';
import { AttachmentType, type Attachment } from '@sdk/entities/flow-message';
import { useEntity } from '@sdk/react/hooks';
import { PromptAttachmentPreview } from '@src/components/conversation/attachment-actions';
import { isImagePromptFileAttachment } from '@src/components/conversation/attachment-actions/prompt-attachment';

vi.mock('@sdk/react/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk/react/hooks')>();
  return { ...actual, useEntity: vi.fn() };
});

const mockUseEntity = vi.mocked(useEntity);

const PROMPT_ID = 'e5e5e5e5-0000-4000-8000-000000000005';

describe('PromptAttachmentPreview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseEntity.mockReturnValue({ data: null } as never);
  });
  afterEach(() => cleanup());

  it('renders legacy inline prompt text (truncated, with the row label)', () => {
    const att: Attachment = { attachment_type: AttachmentType.PROMPT, data: 'run the linter please' };
    render(<PromptAttachmentPreview attachments={[att]} messageId="fm-1" />);
    expect(screen.getByText('Prompt to run:')).toBeTruthy();
    expect(screen.getByText(/run the linter please/)).toBeTruthy();
  });

  it('renders an entity-backed prompt from prompt_preview (no download needed)', () => {
    const att: Attachment = {
      attachment_type: AttachmentType.TYPE_ID,
      data: `prompt-${PROMPT_ID}`,
      prompt_preview: 'preview text rides the header',
    };
    render(
      <PromptAttachmentPreview
        attachments={[att]}
        messageId="fm-1"
        promptEntityTypeId={new TypeId('prompt', PROMPT_ID)}
      />,
    );
    expect(screen.getByText(/preview text rides the header/)).toBeTruthy();
  });

  it('falls back to the fetched entity text when prompt_preview is absent', () => {
    mockUseEntity.mockReturnValue({ data: { text: 'entity text from library' } } as never);
    const att: Attachment = {
      attachment_type: AttachmentType.TYPE_ID,
      data: `prompt-${PROMPT_ID}`,
    };
    render(
      <PromptAttachmentPreview
        attachments={[att]}
        messageId="fm-1"
        promptEntityTypeId={new TypeId('prompt', PROMPT_ID)}
      />,
    );
    expect(screen.getByText(/entity text from library/)).toBeTruthy();
  });

  it('composer mode (no messageId) renders legacy file chips without links', () => {
    const att: Attachment = { attachment_type: AttachmentType.PROMPT, data: 'prompt/notes.md' };
    const { container } = render(<PromptAttachmentPreview attachments={[att]} />);
    expect(screen.getByText('notes.md')).toBeTruthy();
    expect(container.querySelector('a')).toBeNull();
  });

  it('leaves a sent image prompt-file to the attachment chips (not the prompt row)', () => {
    // On a sent message the image renders as a rich image AttachmentChip (see
    // useAttachments) — the prompt row must NOT also show it as a name/thumbnail.
    const att: Attachment = {
      attachment_type: AttachmentType.PROMPT,
      data: 'prompt/diagram.png',
      local_path: '/tmp/diagram.png',
    };
    const { container } = render(<PromptAttachmentPreview attachments={[att]} messageId="fm-1" />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.queryByText('diagram.png')).toBeNull();
  });

  it('shows the typed text in the prompt row and leaves the image to the chips', () => {
    const text: Attachment = { attachment_type: AttachmentType.PROMPT, data: 'run the migration' };
    const image: Attachment = {
      attachment_type: AttachmentType.PROMPT,
      data: 'prompt/screenshot.jpg',
      local_path: '/tmp/screenshot.jpg',
    };
    const { container } = render(<PromptAttachmentPreview attachments={[text, image]} messageId="fm-2" />);
    // Typed prompt stays text on the row…
    expect(screen.getByText(/run the migration/)).toBeTruthy();
    // …and the image is not duplicated here — it's an attachment chip.
    expect(container.querySelector('img')).toBeNull();
  });

  it('classifies image prompt-files as chip-renderable, text prompt-files as not', () => {
    const img: Attachment = { attachment_type: AttachmentType.PROMPT, data: 'prompt/shot.png' };
    const txt: Attachment = { attachment_type: AttachmentType.PROMPT, data: 'prompt/notes.md' };
    const inline: Attachment = { attachment_type: AttachmentType.PROMPT, data: 'just text' };
    expect(isImagePromptFileAttachment(img)).toBe(true);
    expect(isImagePromptFileAttachment(txt)).toBe(false);
    expect(isImagePromptFileAttachment(inline)).toBe(false);
  });

  it('thumbnails a not-yet-uploaded image in the composer from its backing File', async () => {
    // jsdom has no object-URL API; install harmless mocks (left in place so the
    // component's unmount cleanup can still call revokeObjectURL).
    const createObjectURL = vi.fn(() => 'blob:pasted');
    (URL as unknown as { createObjectURL: typeof createObjectURL }).createObjectURL = createObjectURL;
    (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = vi.fn();

    const att: Attachment = { attachment_type: AttachmentType.PROMPT, data: 'prompt/pasted.png' };
    const file = new File(['png-bytes'], 'pasted.png', { type: 'image/png' });
    render(<PromptAttachmentPreview attachments={[att]} pendingFiles={[file]} />);
    // Object URL is minted in an effect, so the thumbnail appears after a tick.
    const img = (await screen.findByAltText('pasted.png')) as HTMLImageElement;
    expect(img.tagName).toBe('IMG');
    expect(createObjectURL).toHaveBeenCalledWith(file);
  });
});
