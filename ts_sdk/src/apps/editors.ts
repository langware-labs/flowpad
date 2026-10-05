/**
 * Which apps edit a thing, best first — the backend's one rule (`flow_sdk/assets/editors.py`):
 * an editor NESTED in the subject, then one whose `edits` covers the subject's declared kind, then
 * one that `edits` its type. `why` says which.
 */
import apiClient from '../client';

export interface EditorChoice {
  typeid: string;
  name: string;
  title: string;
  why: 'nested' | 'kind' | 'type';
}

export async function editorsFor(subjectTypeId: string): Promise<EditorChoice[]> {
  try {
    return (await apiClient.get<EditorChoice[]>(`/api/v1/editors/${encodeURIComponent(subjectTypeId)}`)) ?? [];
  } catch {
    return [];
  }
}
