/**
 * Browsing what a RAG index holds, and opening a chunk's document.
 *
 * The browser lists the index's documents and one document's chunks in reading order, starting
 * on the first document rather than an unordered wall. Clicking a chunk is a navigation by the
 * chunk's machine path — the click writes nothing else (URL-first).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { listChunks, openMachinePath } = vi.hoisted(() => ({
  listChunks: vi.fn(),
  openMachinePath: vi.fn(),
}));

vi.mock('@src/components/rag/rag-service', () => ({ listChunks }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openMachinePath } }),
}));

const { RagChunkBrowser } = await import('@src/components/rag/RagChunkBrowser');

const A = '/Users/alice/ws/docs/a.md';
const B = '/Users/alice/ws/docs/b.md';
const documents = [
  { doc_ref: A, chunk_count: 2 },
  { doc_ref: B, chunk_count: 1 },
];
const chunk = (doc_ref: string, text: string, heading: string[]) => ({
  chunk_id: `${doc_ref}:${text}`,
  doc_ref,
  heading_path: heading,
  text,
});

beforeEach(() => {
  openMachinePath.mockReset();
  listChunks.mockReset();
  listChunks.mockImplementation(async (_id: string, { docRef, offset = 0 }: { docRef?: string; offset?: number }) => {
    if (!docRef) return { documents, chunks: [], total: 3 };
    if (docRef === B) return { chunks: [chunk(B, 'bee text', ['B'])], total: 1 };
    const all = [chunk(A, 'first', ['A', 'One']), chunk(A, 'second', ['A', 'Two'])];
    // A page of one, so "Show more" has to page by offset and append.
    return { chunks: all.slice(offset, offset + 1), total: 2 };
  });
});

describe('RagChunkBrowser', () => {
  it('opens on the first document and pages its chunks forward in order', async () => {
    render(<RagChunkBrowser indexId="ix" chunkCount={3} />);
    await waitFor(() => expect(screen.getByText('first')).toBeTruthy());
    expect(screen.getByTestId('rag-browse-chunks').textContent).toContain('A › One');
    expect(screen.getByTestId('rag-browse-doc:a.md').textContent).toContain('2');

    fireEvent.click(screen.getByText(/Show more/));
    await waitFor(() => expect(screen.getByText('second')).toBeTruthy());
    expect(screen.getByTestId('rag-browse-chunks').textContent).toMatch(/first[\s\S]*second/);
    expect(listChunks).toHaveBeenLastCalledWith('ix', expect.objectContaining({ docRef: A, offset: 1 }));
  });

  it('switches document on click', async () => {
    render(<RagChunkBrowser indexId="ix" chunkCount={3} />);
    await waitFor(() => screen.getByTestId('rag-browse-doc:b.md'));
    fireEvent.click(screen.getByTestId('rag-browse-doc:b.md'));
    await waitFor(() => expect(screen.getByText('bee text')).toBeTruthy());
    expect(listChunks).toHaveBeenLastCalledWith('ix', expect.objectContaining({ docRef: B }));
  });

  it('a chunk opens its document by machine path, and does nothing else', async () => {
    render(<RagChunkBrowser indexId="ix" chunkCount={3} />);
    await waitFor(() => screen.getByText('first'));
    fireEvent.click(screen.getByText('first'));
    expect(openMachinePath).toHaveBeenCalledTimes(1);
    expect(openMachinePath.mock.calls[0][0]).toBe(A);
  });

  it('says so when nothing is indexed', async () => {
    listChunks.mockResolvedValue({ documents: [], chunks: [], total: 0 });
    render(<RagChunkBrowser indexId="ix" chunkCount={0} />);
    await waitFor(() => expect(screen.getByTestId('rag-browse-empty')).toBeTruthy());
  });
});
