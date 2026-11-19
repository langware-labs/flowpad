import { apiClient } from '@sdk';

/** What the local server says about a page key: whether it asks for keys at all, and what `key` stands for. */
export interface PageKeyAnswer {
  enforced: boolean;
  probed: { context?: Record<string, string> } | null;
}

/** Mint a key for a page opened beside `processId` (or none). Only the app itself — and machine callers — may. */
export async function mintPageKey(title: string, processId?: string | null): Promise<string> {
  const answer = (await apiClient.post('/api/v1/page-state', {
    title,
    context: processId ? { process: `agentic_process-${processId}` } : {},
  })) as { key: string };
  return answer.key;
}

/**
 * Ask the local server about the key a dock or link carries. An unknown key answers `probed: null` (never a
 * 403, which would make the app's own window report a refusal it never suffered). Rejects when the server
 * cannot be asked — callers treat that as "not vouched for".
 */
export async function probePageKey(key: string | null | undefined): Promise<PageKeyAnswer> {
  return (await apiClient.get('/api/v1/page-state', { params: key ? { probe: key } : undefined })) as PageKeyAnswer;
}
