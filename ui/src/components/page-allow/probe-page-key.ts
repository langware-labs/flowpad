import { apiClient } from '@sdk';

/** What the local server says about a page key: whether it asks for keys at all, and what `key` stands for. */
export interface PageKeyAnswer {
  enforced: boolean;
  probed: { context?: Record<string, string> } | null;
}

/**
 * Ask the local server about the key a dock or link carries. An unknown key answers `probed: null` (never a
 * 403, which would make the app's own window report a refusal it never suffered). Rejects when the server
 * cannot be asked — callers treat that as "not vouched for".
 */
export async function probePageKey(key: string | null | undefined): Promise<PageKeyAnswer> {
  const answer = (await apiClient.get('/api/v1/page-state', { params: key ? { probe: key } : undefined })) as PageKeyAnswer;
  if (key && answer.probed) vouched.set(key, answer.probed.context ?? {});
  return answer;
}

/** Keys the server already vouched for, with what each stands for: a warm return asks the backend nothing. */
const vouched = new Map<string, Record<string, string>>();

/** What a key the server already vouched for stands for, or undefined when it has not been asked about (or is unknown). */
export function vouchedContext(key: string | null | undefined): Record<string, string> | undefined {
  return key ? vouched.get(key) : undefined;
}
