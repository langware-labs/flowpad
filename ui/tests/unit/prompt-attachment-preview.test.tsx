import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TypeId } from '@sdk';
import { AttachmentType, type Attachment } from '@sdk/entities/flow-message';
import { useEntity } from '@sdk/react/hooks';
import { PromptAttachmentPreview } from '@src/components/conversation/attachment-actions';

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
});
