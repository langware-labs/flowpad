/**
 * The four verbs of a `RagIndex`, over `apiClient`.
 *
 * They live here rather than on the entity because the entity is a data mirror and these are
 * actions on a row that already exists; `llm-endpoints-service` is the same shape. Every call
 * takes a path, never a URL — the base is `apiClient`'s business.
 */
import apiClient from '@sdk/client';

const base = (id: string) => `/api/v1/graph/rag_index/${encodeURIComponent(id)}`;

export interface RagHit {
  doc_ref: string;
  heading_path: string[];
  text: string;
  score: number;
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
