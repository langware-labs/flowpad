import { Conversation, FeedEntry, sendToExistingConversation } from '@sdk';
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
 * - reportIssue: the single send path. Both "Report issue" (the suggested
 *   support conversation) and a Forward pick (any existing conversation) call
 *   this with their conversation id — it sends the generated report text via
 *   the unified send path, then dismisses the entry and un-hides the
 *   conversation (clear dismissed_at + bump updated_date) so it appears in
 *   the Recent strip. The entry is dismissed only after the send succeeds.
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

  const reportIssue = useCallback(
    async (entry: FeedEntry, conversationId: string) => {
      await sendToExistingConversation(conversationId, {
        text: entry.messageSuggest?.message_text ?? '',
      });
      entry.feed_status = 'dismissed';
      // Un-hide the conversation so it shows in the Recent strip — the send
      // itself doesn't clear dismissed_at. Skipped if the fetch comes back
      // empty; independent of the entry save, so the two run in parallel.
      const unhide = async () => {
        const conv = await Conversation.getById<Conversation>(conversationId);
        if (!conv) return;
        conv.dismissed_at = null;
        conv.updated_date = new Date().toISOString();
        await conv.save([]);
      };
      await Promise.all([entry.save([]), unhide()]);
      await refetch();
    },
    [refetch],
  );

  return { dismiss, reportIssue };
}
