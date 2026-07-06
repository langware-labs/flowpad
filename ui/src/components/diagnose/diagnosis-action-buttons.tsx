import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@src/components/ui/button';
import { deriveConversationTitle } from '@src/components/conversation/conversation-title';
import { ForwardDiagnosisShareDialog } from '@src/components/diagnose/forward-diagnosis-share-dialog';
import { OpenInTerminalButton } from '@src/components/diagnose/open-in-terminal-button';
import { useRecentConversations } from '@src/hooks/use-recent-conversations';
import { formatTimeAgo } from '@src/utils/format-time-ago';
import { Check, EyeOff, Forward, MessageSquarePlus } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useDiagnosisReportAvailability } from './use-diagnosis-report-availability';

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
  /** The report was already sent — render "✓ Reported" disabled so the user
   *  sees it succeeded and can't email the team a duplicate. */
  reported?: boolean;
  /** "Forward" — post the formatted report into the chosen conversation. */
  onForward: (conversationId: string) => void;
  /** The FlowpadDiagnosis entity id. When set, the Forward list gains a "Start
   *  new conversation" row that forwards into a brand-new conversation (with a
   *  recipient picker), not only an existing one. */
  diagnosisId?: string;
  /** Diagnosis display title — labels the new-conversation share source. */
  diagnosisTitle?: string;
  /** Called after a successful forward into a *new* conversation — lets the
   *  caller dismiss its own surface (the navigation is handled internally). */
  onForwardedNew?: (conversationId: string) => void;
  /** Show the "Open in terminal" action. Only the diagnosis viewer sets this —
   *  the Feed card routes through its "View" button to the viewer instead. */
  showOpenInTerminal?: boolean;
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
  reported,
  onForward,
  diagnosisId,
  diagnosisTitle,
  onForwardedNew,
  showOpenInTerminal,
  trailing,
}: DiagnosisActionButtonsProps) {
  const { t } = useLingui();
  const reportAvailability = useDiagnosisReportAvailability();
  const [forwardOpen, setForwardOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // Forward target list: most recent conversations, fetched only while open. The
  // suggested support conversation is excluded — "Report issue" already targets it.
  const conversations = useRecentConversations(forwardOpen, {
    excludeId: suggestedConversationId,
  });

  // The list expands *below* the button row. In a scroll-capped surface (the
  // diagnosis popup) it can open below the fold — the user sees only a scrollbar.
  // Scroll it into view on open so the conversations are visibly revealed.
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (forwardOpen) listRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [forwardOpen, conversations.length]);

  const reportDisabledReason = !canReport
    ? t`Diagnosis is not available yet`
    : reportAvailability.disabledReason;
  const reportDisabled = busy || !canReport || !reportAvailability.canReport;

  return (
    <>
      <div className="mt-2 flex shrink-0 flex-wrap items-center gap-2">
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
        {reported ? (
          <Button type="button" size="sm" variant="outline" disabled className="h-6 gap-1 px-2 text-xs">
            <Check className="h-3.5 w-3.5" />
            <Trans>Reported</Trans>
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            disabled={reportDisabled}
            title={reportDisabledReason}
            onClick={onReportIssue}
            className="h-6 px-2 text-xs"
          >
            <Trans>Report issue</Trans>
          </Button>
        )}
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
        {showOpenInTerminal && diagnosisId && <OpenInTerminalButton diagnosisId={diagnosisId} />}
        {trailing && <div className="ml-auto flex items-center">{trailing}</div>}
      </div>

      {forwardOpen && (
        <ul
          ref={listRef}
          className="mt-2 flex max-h-48 min-h-0 flex-col gap-1 overflow-y-auto overscroll-contain"
          data-testid="feed-forward-conversations"
        >
          {conversations.length === 0 && !diagnosisId ? (
            <li className="px-2 py-1 text-xs text-muted-foreground">
              <Trans>No conversations yet.</Trans>
            </li>
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
                  <span className="flex-1 truncate text-foreground">{deriveConversationTitle(conv)}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {formatTimeAgo(conv.updated_date ? new Date(conv.updated_date).toISOString() : null) ?? ''}
                  </span>
                </button>
              </li>
            ))
          )}
          {/* "Start new conversation" — opens the share dialog (recipient picker)
              so the diagnosis can be forwarded into a brand-new conversation. */}
          {diagnosisId && (
            <li className={conversations.length > 0 ? 'mt-1 border-t border-border/60 pt-1' : undefined}>
              <button
                type="button"
                disabled={busy}
                onClick={() => setShareOpen(true)}
                className="flex w-full items-center gap-2 rounded-md border border-dashed border-input bg-background px-2 py-1.5 text-left text-xs text-foreground hover:bg-muted/50 disabled:pointer-events-none disabled:opacity-50"
                data-testid="feed-forward-conv-new"
              >
                <MessageSquarePlus className="h-3.5 w-3.5 shrink-0 text-primary" />
                <span className="flex-1 truncate">
                  <Trans>Start new conversation</Trans>
                </span>
              </button>
            </li>
          )}
        </ul>
      )}

      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}

      {diagnosisId && (
        <ForwardDiagnosisShareDialog
          open={shareOpen}
          onClose={() => setShareOpen(false)}
          diagnosisId={diagnosisId}
          diagnosisTitle={diagnosisTitle}
          onForwarded={(conversationId) => {
            setForwardOpen(false);
            onForwardedNew?.(conversationId);
          }}
        />
      )}
    </>
  );
}
