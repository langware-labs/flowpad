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
    files: [{ path: file, size: 10, is_main: true }],
    main_file: file,
    asset_root: null,
    root: 'unpacked/attachment/file-1',
    abs_root: ABS_ROOT,
  } as never);
  return ma;
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
  ])('%s → %s, by its staged path', async (file, testId) => {
    renderReview(staged(file));
    const el = await screen.findByTestId(testId);
    expect(el.getAttribute('src')).toContain(`${ABS_ROOT}/${file}`);
  });

  it('a .md opens in the markdown viewer in View mode, read-only', async () => {
    const write = vi.spyOn(FSRef.prototype, 'write');
    renderReview(staged('notes.md'));
    expect((await screen.findByTestId('editor-mode-chip-view')).getAttribute('data-mode-active')).toBe('true');
    expect(document.querySelector('[contenteditable="true"]')).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });
});
