import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { FSRef, MessageAttachment } from '@sdk';
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

describe('review opens the staged copy by path in its own viewer, read-only', () => {
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

  it('a .md opens in the markdown viewer in View mode, never through the text read', async () => {
    const write = vi.spyOn(FSRef.prototype, 'write');
    const { ma, read } = staged('notes.md');
    renderReview(ma);
    expect((await screen.findByTestId('editor-mode-chip-view')).getAttribute('data-mode-active')).toBe('true');
    expect(read).not.toHaveBeenCalled();
    expect(document.querySelector('[contenteditable="true"]')).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });
});
