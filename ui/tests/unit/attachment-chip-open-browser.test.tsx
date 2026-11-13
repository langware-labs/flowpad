/** The attachment card shows "Open in browser" only for an HTML file that is on this machine. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';


import { FSRef } from '@sdk';
import { AttachmentChip } from '@src/components/conversation/AttachmentChip';

const URL_ = '/api/v1/graph/flow_message/m/fs/download/data/mock.html';

describe('AttachmentChip open in browser', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('opens a local HTML file in the system browser', () => {
    const open = vi.spyOn(FSRef.prototype, 'open').mockResolvedValue(null);
    render(<AttachmentChip url={URL_} filename="mock.html" localPath="/Users/me/mock.html" />);
    fireEvent.click(screen.getByTestId('attachment-open-browser'));
    expect(open.mock.contexts.map((ref) => (ref as FSRef).path)).toEqual(['/Users/me/mock.html']);
  });

  it('shows no globe for a file that is not local or not HTML', () => {
    render(<AttachmentChip url={URL_} filename="mock.html" />);
    render(<AttachmentChip url={URL_} filename="notes.md" localPath="/Users/me/notes.md" />);
    expect(screen.queryByTestId('attachment-open-browser')).toBeNull();
  });
});
