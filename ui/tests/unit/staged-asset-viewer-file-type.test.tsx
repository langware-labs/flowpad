import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MessageAttachment } from '@sdk';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StagedAssetViewer } from '@src/components/conversation/asset-review/StagedAssetViewer';

vi.mock('@src/components/agent-layout/agent-layout', () => ({
  useAgentContext: () => ({ computeNode: null, flow: null }),
}));

const ABS_ROOT = '/data/records_data/flow_message/m1/unpacked/attachment/file-1';

/** A received FILE attachment whose staged tree holds exactly `file`. */
function staged(file: string) {
  const ma = new MessageAttachment({ id: crypto.randomUUID(), asset_type: 'file', name: file } as never);
  vi.spyOn(ma, 'listStagedFiles').mockResolvedValue({
    files: [{ path: file, size: 10, is_main: false }],
    main_file: null,
    root: 'unpacked/attachment/file-1',
    abs_root: ABS_ROOT,
  } as never);
  const read = vi.spyOn(ma, 'readStagedFile').mockResolvedValue({ path: file, content: '# Notes', truncated: false } as never);
  return { ma, read };
}

function renderReview(ma: MessageAttachment) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={['/dock/conversation/c1']}>
        <Routes><Route path="/dock/*" element={<StagedAssetViewer attachment={ma} />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('staged review renders a received file with its file-type viewer', () => {
  it.each([
    ['report.pdf', 'pdf-viewer'],
    ['photo.png', 'media-viewer-image'],
    ['clip.mp4', 'media-viewer-video'],
    ['voice.mp3', 'media-viewer-audio'],
  ])('%s → %s, never through the text read', async (file, testId) => {
    const { ma, read } = staged(file);
    renderReview(ma);
    const el = await screen.findByTestId(testId);
    expect(el.getAttribute('src')).toContain(`${ABS_ROOT}/${file}`);
    expect(read).not.toHaveBeenCalled();
    expect(screen.queryByText('Select a file to preview.')).toBeNull();
  });

  it('keeps the markdown preview for a .md', async () => {
    const { ma, read } = staged('notes.md');
    renderReview(ma);
    await screen.findByRole('heading', { name: 'Notes' });
    expect(read).toHaveBeenCalledWith('notes.md');
  });
});
