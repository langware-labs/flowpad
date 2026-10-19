/**
 * Record search — the full-text index over Flowpad's records (tasks, skills, agents, docs,
 * sessions, source items…): `GET /api/v1/search`, the call `flow record search` makes and
 * `Entity.search` answers in Python. Dataset ROWS are not in this index (a dataset is one record);
 * a row's text is found with `dataset.query({q})`.
 */
import apiClient from '../client';

/** One record a search found. */
export interface SearchResult {
  record_id: string;
  record_type: string;
  name: string;
  snippet?: string;
  status?: string | null;
  scope?: string | null;
  remote?: boolean;
  project_id?: string | null;
  asset_ref?: string | null;
  created_at?: string | null;
  modified_at?: string | null;
  [more: string]: unknown;
}

export interface SearchAnswer {
  results: SearchResult[];
  query: string;
  total: number;
  /** False while the index is still being built: fewer results than there will be. */
  indexer_ready: boolean;
}

export interface SearchOptions {
  limit?: number;
  offset?: number;
  /** Only records of this type (`task`, `skill`, `markdown`, `source_item`…). */
  record_type?: string;
  status?: string;
  projects?: string[];
  tags?: string[];
}

/** Search the records for `q` (every word must appear). Newest and best matches first. */
export async function searchRecords(q: string, options: SearchOptions = {}): Promise<SearchAnswer> {
  const { projects, tags, ...rest } = options;
  const params: Record<string, unknown> = { q, ...rest };
  if (projects?.length) params.projects = projects.join(',');
  if (tags?.length) params.tags = tags.join(',');
  const found = await apiClient.get<Partial<SearchAnswer>>('/search', { params });
  return { results: found?.results ?? [], query: found?.query ?? q, total: found?.total ?? 0, indexer_ready: found?.indexer_ready ?? true };
}
