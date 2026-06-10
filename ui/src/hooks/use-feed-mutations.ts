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
 * - markSentToSupport: post-share bookkeeping after the unified share dialog
 *   has sent the report — same status flip, plus un-hide the conversation the
 *   share landed in (clear dismissed_at + bump updated_date) so it appears in
 *   the Recent strip. The send itself is owned by ShareToConversationDialog.
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

  const markSentToSupport = useCallback(
    async (entry: FeedEntry, conversationId: string) => {
      entry.feed_status = 'dismissed';
      await entry.save([]);
      const conv = await Conversation.getById<Conversation>(conversationId);
      if (conv) {
        conv.dismissed_at = null;
        conv.updated_date = new Date().toISOString();
        await conv.save([]);
      }
      await refetch();
    },
    [refetch],
  );

  return { dismiss, markSentToSupport };
}
