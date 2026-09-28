/**
 * The terminal's Files side tab: each pasted/dropped file row offers, beside
 * delete, "paste path at cursor" (handed to the host, which owns the input),
 * "copy path" and "reveal in Finder/Explorer" (open-external with select).
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TypeId } from '@sdk';

const { copyToClipboard, openExternalFromComputeNode } = vi.hoisted(() => ({
  copyToClipboard: vi.fn(async () => {}),
  openExternalFromComputeNode: vi.fn(async () => null),
}));

vi.mock('@sdk', async (importOriginal) => ({ ...(await importOriginal<object>()), copyToClipboard }));
vi.mock('@sdk/entities/compute-node', () => ({ openExternalFromComputeNode }));
vi.mock('@src/hooks/useFS', () => ({
  useFS: () => ({
    browse: () => ({ items: [{ name: 'shot.png', relativePath: 'in/shot.png', is_dir: false, size: 10 }] }),
    getDownloadUrl: () => 'blob:shot',
  }),
}));

import { InputFilesPanel } from '@src/components/terminal/interactive-terminal/side-windows/InputFilesPanel';

const NODE = new TypeId('compute_node', '@local');
const DIR = '/tmp/input dir';
const PATH = `${DIR}/shot.png`;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('InputFilesPanel row actions', () => {
  it('pastes the file path through the host', () => {
    const onInsertPath = vi.fn();
    render(<InputFilesPanel computeNodeTypeId={NODE} inputDirAbsPath={DIR} onInsertPath={onInsertPath} />);
    fireEvent.click(screen.getByLabelText('Paste path of shot.png'));
    expect(onInsertPath).toHaveBeenCalledWith(PATH);
  });

  it('copies the file path', () => {
    render(<InputFilesPanel computeNodeTypeId={NODE} inputDirAbsPath={DIR} />);
    fireEvent.click(screen.getByLabelText('Copy path of shot.png'));
    expect(copyToClipboard).toHaveBeenCalledWith(PATH);
  });

  it('reveals the file in the OS file manager', () => {
    render(<InputFilesPanel computeNodeTypeId={NODE} inputDirAbsPath={DIR} />);
    fireEvent.click(screen.getByLabelText('Reveal shot.png in Finder/Explorer'));
    expect(openExternalFromComputeNode).toHaveBeenCalledWith('@local', PATH, { select: true });
  });

  it('offers no paste button when the host has no input to paste into', () => {
    render(<InputFilesPanel computeNodeTypeId={NODE} inputDirAbsPath={DIR} />);
    expect(screen.queryByLabelText('Paste path of shot.png')).not.toBeInTheDocument();
  });
});
