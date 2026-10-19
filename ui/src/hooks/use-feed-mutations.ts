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
  const dismissAll = useCallback(
    async (entries: readonly FeedEntry[]) => {
      await Promise.all(
        entries.map((entry) => {
          entry.feed_status = 'dismissed';
          return entry.save([]);
        }),
      );
      await refetch();
    },
    [refetch],
  );

  const dismiss = useCallback((entry: FeedEntry) => dismissAll([entry]), [dismissAll]);

  return { dismiss, dismissAll };
}
