import { FeedEntry, sendDiagnosisReport } from '@sdk';
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
      // Shared send path: post the report into the conversation and un-hide it so
      // it surfaces in the Recent strip (same helper the diagnose modal uses).
      await sendDiagnosisReport(conversationId, entry.messageSuggest?.message_text ?? '');
      // Then dismiss the Feed entry — only after the send succeeds.
      entry.feed_status = 'dismissed';
      await entry.save([]);
      await refetch();
    },
    [refetch],
  );

  return { dismiss, reportIssue };
}
