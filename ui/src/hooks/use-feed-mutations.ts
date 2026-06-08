import { Conversation, FeedEntry } from '@sdk';
import { useCallback } from 'react';

interface UseFeedMutationsOptions {
  refetch: () => Promise<void>;
}

/**
 * Feed entry mutations. These fire from the Home-landing Feed buttons inside the
 * running app, so they go through the live backend like any entity save (no
 * down-backend concern — the report was written SDK-direct by `flow diagnose`).
 *
 * - dismiss: flip feed_status → 'dismissed' so the entry stops rendering.
 * - sendToSupport: same flip, plus un-hide the linked support Conversation
 *   (clear dismissed_at + bump updated_date) so it appears in the Recent strip.
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

  const sendToSupport = useCallback(
    async (entry: FeedEntry) => {
      entry.feed_status = 'dismissed';
      await entry.save([]);
      const convId = entry.messageSuggest?.conversation_id;
      if (convId) {
        const conv = await Conversation.getById<Conversation>(convId);
        if (conv) {
          conv.dismissed_at = null;
          conv.updated_date = new Date().toISOString();
          await conv.save([]);
        }
      }
      await refetch();
    },
    [refetch],
  );

  return { dismiss, sendToSupport };
}
