import { FeedEntry } from '@sdk';
import { useCallback } from 'react';

interface UseFeedMutationsOptions {
  refetch: () => Promise<void>;
}

/**
 * Feed entry lifecycle mutations. Content-specific actions live with the
 * renderer for the entity referenced by FeedEntry.data.
 */
export function useFeedMutations({ refetch }: UseFeedMutationsOptions) {
  const dismiss = useCallback(
    async (entry: FeedEntry) => {
      entry.feed_status = 'dismissed';
      await entry.save([]);
      await refetch();
    },
    [refetch],
  );

  return { dismiss };
}
