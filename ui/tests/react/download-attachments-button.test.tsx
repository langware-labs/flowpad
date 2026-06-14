import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DownloadAttachmentsButton } from '@src/components/conversation/FlowMessageBubble';

describe('DownloadAttachmentsButton', () => {
  it('renders attachment type chips on the pre-download button', () => {
    render(
      <DownloadAttachmentsButton
        count={3}
        labels={['skill-1', 'markdown-2', 'notes.txt']}
        typeChips={[
          { key: 'skill', type: 'skill', label: 'Skill', count: 1 },
          { key: 'markdown', type: 'markdown', label: 'Markdown', count: 1 },
          { key: 'file', type: 'file', label: 'File', count: 1 },
        ]}
        uploading={false}
        downloading={false}
        onDownload={vi.fn()}
      />,
    );

    const button = screen.getByTestId('download-attachments-button');
    expect(button).toHaveTextContent('3 assets attached');
    expect(screen.getByTestId('download-asset-type-chip-skill')).toHaveTextContent('Skill');
    expect(screen.getByTestId('download-asset-type-chip-markdown')).toHaveTextContent('Markdown');
    expect(screen.getByTestId('download-asset-type-chip-file')).toHaveTextContent('File');
  });
});
