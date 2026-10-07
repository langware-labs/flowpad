/**
 * The verbs of a `RagIndex`, over `apiClient`.
 *
 * They live here rather than on the entity because the entity is a data mirror and these are
 * actions on a row that already exists; `llm-endpoints-service` is the same shape. Every call
 * takes a path, never a URL — the base is `apiClient`'s business.
 */
import apiClient from '@sdk/client';

const base = (id: string) => `/api/v1/graph/rag_index/${encodeURIComponent(id)}`;

/** A stored chunk: a search hit, or (with `score` 0) a row of the chunk browser. */
export interface RagHit {
  chunk_id: string;
  doc_ref: string;
  heading_path: string[];
  text: string;
  score: number;
}

/**
 * Make *path* searchable, or stop — addressed by path, not by index.
 *
 * The tree asks this; it knows a folder and has no reason to know which index owns it. The
 * backend finds the box's single index or creates it, so the first folder anybody marks does
 * not first require a trip to the Search indexes screen.
 */
export async function toggleRoot(path: string): Promise<boolean> {
  const data = await apiClient.post<{ covered: boolean; index_id: string; roots: string[] }>(
    '/api/v1/graph/rag-toggle-root',
    { path },
  );
  return !!data?.covered;
}

export async function addRoot(id: string, path: string): Promise<void> {
  await apiClient.post(`${base(id)}/add-root`, { path });
}

export async function removeRoot(id: string, path: string): Promise<void> {
  await apiClient.post(`${base(id)}/remove-root`, { path });
}

/** Schedules a pass and returns immediately; `refusal` says why it did not. */
export async function runIndex(id: string, opts: { force?: boolean } = {}): Promise<string> {
  const data = await apiClient.post<{ scheduled: boolean; refusal: string }>(`${base(id)}/index`, {
    force: !!opts.force,
  });
  return data?.refusal ?? '';
}

export async function queryIndex(
  id: string,
  q: string,
  topK = 8,
): Promise<{ hits: RagHit[]; refusal: string }> {
  const data = await apiClient.post<{ hits: RagHit[]; refusal: string }>(`${base(id)}/query`, {
    q,
    top_k: topK,
  });
  return { hits: data?.hits ?? [], refusal: data?.refusal ?? '' };
}

export interface RagChunkPage {
  /** One page of chunks in reading order — one document's when `docRef` is given. */
  chunks: RagHit[];
  /** How many chunks the page is drawn from, for paging. */
  total: number;
  /** Every document the index holds, with its chunk count. Only on the unscoped call. */
  documents?: { doc_ref: string; chunk_count: number }[];
}

/** Browse what the index holds. Reads the store's sidecar only — no embedding, no cost. */
export async function listChunks(
  id: string,
  opts: { docRef?: string; offset?: number; limit?: number } = {},
): Promise<RagChunkPage> {
  const data = await apiClient.post<RagChunkPage>(`${base(id)}/chunks`, {
    doc_ref: opts.docRef ?? '',
    offset: opts.offset ?? 0,
    limit: opts.limit ?? 50,
  });
  return { chunks: data?.chunks ?? [], total: data?.total ?? 0, documents: data?.documents };
}
