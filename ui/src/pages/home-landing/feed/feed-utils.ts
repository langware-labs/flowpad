import { FeedEntry, TypeId } from '@sdk';

export function formatRecorded(value?: string | Date): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

export function getFeedEntryTypeId(entry: FeedEntry): TypeId | null {
  const data = entry.data;
  if (!data || typeof data.type_id !== 'string') return null;
  try {
    return new TypeId(data.type_id);
  } catch {
    return null;
  }
}
