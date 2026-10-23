export interface BulkResult<T> {
  ok: T[];
  failed: { item: T; error: unknown }[];
}

/**
 * Run `fn` on every item, at most `limit` at a time, and report each outcome.
 * Never throws: one machine failing must not stop the rest.
 */
export async function runLimited<T>(items: T[], fn: (item: T) => Promise<unknown>, limit = 4): Promise<BulkResult<T>> {
  const result: BulkResult<T> = { ok: [], failed: [] };
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
        result.ok.push(item);
      } catch (error) {
        result.failed.push({ item, error });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return result;
}
