import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@src/components/ui/button';
import { deriveConversationTitle } from '@src/components/conversation/conversation-title';
import { useRecentConversations } from '@src/hooks/use-recent-conversations';
import { formatTimeAgo } from '@src/utils/format-time-ago';
import { EyeOff, Forward } from 'lucide-react';
import { useState, type ReactNode } from 'react';

interface DiagnosisActionButtonsProps {
  /** The support conversation — excluded from the Forward list (you don't forward
   *  a report back into the conversation that already holds it). */
  suggestedConversationId?: string;
  busy?: boolean;
  error?: string;
  /** Feed cards render hide in their constant header; modals keep the inline dismiss action. */
  showDismiss?: boolean;
  /** Dismiss the diagnosis surface (Feed card: dismiss the entry; modal: close). */
  onDismiss: () => void;
  /** "Report issue" — email the diagnosis to the Flowpad team. */
  onReportIssue: () => void;
  /** Whether reporting is available (a diagnosis id is known). Defaults to true. */
  canReport?: boolean;
  /** "Forward" — post the formatted report into the chosen conversation. */
  onForward: (conversationId: string) => void;
  /** Extra control rendered right-most on the button row (e.g. the feed's View button). */
  trailing?: ReactNode;
}

/**
 * The action row at the bottom of a diagnosis surface: Dismiss / Report issue /
 * Forward (with a recent-conversation picker). Shared between the Home-Feed
 * `FeedEntryCard` and the UI diagnose modals so both render and behave identically;
 * the data/mutation wiring lives in each caller's `onDismiss` / `onReportIssue` /
 * `onForward`. "Report issue" emails the team; "Forward" posts into a conversation.
 */
export function DiagnosisActionButtons({
  suggestedConversationId,
  busy,
  error,
  showDismiss = true,
  onDismiss,
  onReportIssue,
  canReport = true,
  onForward,
  trailing,
}: DiagnosisActionButtonsProps) {
  const { t } = useLingui();
  const [forwardOpen, setForwardOpen] = useState(false);
  // Forward target list: most recent conversations, fetched only while open. The
  // suggested support conversation is excluded — "Report issue" already targets it.
  const conversations = useRecentConversations(forwardOpen, {
    excludeId: suggestedConversationId,
  });

  return (
    <>
      <div className="mt-2 flex shrink-0 items-center gap-2">
        {showDismiss && (
          <button
            type="button"
            aria-label={t`Dismiss`}
            title={t`Dismiss`}
            disabled={busy}
            onClick={onDismiss}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <EyeOff className="h-3.5 w-3.5" />
          </button>
        )}
        <Button
          type="button"
          size="sm"
          disabled={busy || !canReport}
          onClick={onReportIssue}
          className="h-6 px-2 text-xs"
        >
          <Trans>Report issue</Trans>
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          aria-expanded={forwardOpen}
          onClick={() => setForwardOpen((v) => !v)}
          className="h-6 gap-1 px-2 text-xs"
          data-testid="feed-forward-toggle"
        >
          <Forward className="h-3.5 w-3.5" />
          <Trans>Forward</Trans>
        </Button>
        {trailing && <div className="ml-auto flex items-center">{trailing}</div>}
      </div>

      {forwardOpen && (
        <ul className="mt-2 flex flex-col gap-1" data-testid="feed-forward-conversations">
          {conversations.length === 0 ? (
            <li className="px-2 py-1 text-xs text-muted-foreground"><Trans>No conversations yet.</Trans></li>
          ) : (
            conversations.map((conv) => (
              <li key={conv.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onForward(conv.id)}
                  className="flex w-full items-center gap-2 rounded-md border border-input bg-background px-2 py-1.5 text-left text-xs text-foreground hover:bg-muted/50 disabled:pointer-events-none disabled:opacity-50"
                  data-testid={`feed-forward-conv-${conv.id}`}
                >
                  <span className="flex-1 truncate text-foreground">
                    {deriveConversationTitle(conv)}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {formatTimeAgo(
                      conv.updated_date ? new Date(conv.updated_date).toISOString() : null,
                    ) ?? ''}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}

      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </>
  );
}
