import { DiagnosisActionButtons } from '@src/components/diagnose/diagnosis-action-buttons';
import { DiagnosisReportModal } from '@src/components/version-popover/diagnosis-report-modal';
import { ChevronDown, ChevronRight, Eye, EyeOff } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { AgentTrace, FlowMessage, Markdown, MessageSuggest, UsageReport, UserNote, type FeedEntry } from '@sdk';
import { formatDuration } from '@src/components/lens-viewer/shared/format-utils';
import { useEntity } from '@src/hooks/entity-hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation';
import { Button } from '@src/components/ui/button';
import { cn } from '@src/lib/utils';
import { WikiLabel } from '@src/components/wiki-tip/WikiLabel';
import { HighlightBeacon } from '@src/components/wiki-tip/HighlightBeacon';
import { useLingeringHighlight } from '@src/components/wiki-tip/highlight';
import { FeedData } from './feed-data';
import { formatRecorded } from './feed-utils';

interface FeedEntryCardProps {
  entry: FeedEntry;
  busy: boolean;
  error?: string;
  onDismiss: (entry: FeedEntry) => void;
  /** "Report issue" — email the diagnosis to the Flowpad team. */
  onReportIssue: (entry: FeedEntry, suggest: MessageSuggest) => void;
  /** "Forward" — post the report into the chosen conversation. */
  onForwardMessageSuggest: (entry: FeedEntry, suggest: MessageSuggest, conversationId: string) => void;
}

export function FeedEntryCard({
  entry,
  busy,
  error,
  onDismiss,
  onReportIssue,
  onForwardMessageSuggest,
}: FeedEntryCardProps) {
  const feedData = useMemo(() => FeedData.fromEntry(entry), [entry]);
  const targetTypeId = feedData.targetTypeId;
  const { data: entity, isLoading } = useEntity(targetTypeId, {
    watch: true,
    enabled: !!targetTypeId,
  });

  if (!targetTypeId) {
    return (
      <UnavailableFeedEntryCard
        entry={entry}
        busy={busy}
        feedData={feedData}
        onDismiss={onDismiss}
      />
    );
  }

  if (isLoading || entity === undefined) {
    return (
      <FeedEntryFrame entry={entry} busy={busy} feedData={feedData} onDismiss={onDismiss}>
        <p className="text-xs text-muted-foreground"><Trans>Loading feed item</Trans></p>
      </FeedEntryFrame>
    );
  }

  if (!entity) {
    return (
      <UnavailableFeedEntryCard
        entry={entry}
        busy={busy}
        feedData={feedData}
        onDismiss={onDismiss}
      />
    );
  }

  // WikiTip feed entries carry `data.kind === 'wiki_tip'` and point at a wiki
  // (markdown) page — rendered as a wiki label that highlights on
  // ?highlight=<name>. See docs/wikitip.md.
  if ((entry.data as { kind?: string } | null)?.kind === 'wiki_tip') {
    return (
      <WikiTipFeedEntryCard
        entry={entry}
        page={entity as Markdown}
        busy={busy}
        feedData={feedData}
        onDismiss={onDismiss}
      />
    );
  }

  if (entity.getType() === MessageSuggest.type) {
    return (
      <MessageSuggestFeedEntryCard
        entry={entry}
        suggest={entity as MessageSuggest}
        busy={busy}
        error={error}
        feedData={feedData}
        onDismiss={onDismiss}
        onReportIssue={onReportIssue}
        onForward={onForwardMessageSuggest}
      />
    );
  }

  if (entity.getType() === UserNote.type) {
    return (
      <UserNoteFeedEntryCard
        entry={entry}
        note={entity as UserNote}
        busy={busy}
        feedData={feedData}
        onDismiss={onDismiss}
      />
    );
  }

  if (entity.getType() === AgentTrace.type) {
    return (
      <AgentTraceFeedEntryCard
        entry={entry}
        trace={entity as AgentTrace}
        busy={busy}
        feedData={feedData}
        onDismiss={onDismiss}
      />
    );
  }

  if (entity.getType() === UsageReport.type) {
    return (
      <UsageReportFeedEntryCard
        entry={entry}
        report={entity as UsageReport}
        busy={busy}
        feedData={feedData}
        onDismiss={onDismiss}
      />
    );
  }

  return (
    <UnavailableFeedEntryCard
      entry={entry}
      busy={busy}
      feedData={feedData}
      onDismiss={onDismiss}
    />
  );
}

interface FeedEntryFrameProps {
  entry: FeedEntry;
  busy: boolean;
  feedData: FeedData;
  onDismiss: (entry: FeedEntry) => void;
  children: ReactNode;
  /** Onboarding highlight: ring + attention beacon + scroll-into-view. */
  highlight?: boolean;
  /** During the entrance phase, pulse the ring for extra attention. */
  pulsing?: boolean;
}

function FeedEntryFrame({
  entry,
  busy,
  feedData,
  onDismiss,
  children,
  highlight = false,
  pulsing = false,
}: FeedEntryFrameProps) {
  const { t } = useLingui();
  const Icon = feedData.icon;
  const recorded = formatRecorded(entry.created_date);
  const ref = useRef<HTMLDivElement>(null);
  const hideLabel = t`Hide feed entry`;

  useEffect(() => {
    if (highlight) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlight]);

  return (
    <div
      ref={ref}
      data-highlighted={highlight || undefined}
      className={cn(
        'relative flex max-h-96 flex-col rounded border border-border bg-muted/40 px-2.5 py-2 text-left transition-all duration-500',
        highlight && 'border-primary bg-primary/5 ring-2 ring-primary ring-offset-1 ring-offset-background',
        pulsing && 'animate-pulse',
      )}
    >
      {highlight && <HighlightBeacon />}
      <div className="flex shrink-0 items-center justify-between gap-2">
        <span
          title={feedData.iconTooltip}
          aria-label={feedData.iconTooltip}
          className="flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground"
        >
          <Icon className="h-3.5 w-3.5" aria-hidden />
        </span>
        <div className="flex min-w-0 shrink-0 items-center gap-1.5">
          {recorded && (
            <p className="shrink-0 whitespace-nowrap text-[10px] text-muted-foreground">{recorded}</p>
          )}
          <button
            type="button"
            aria-label={hideLabel}
            title={hideLabel}
            disabled={busy}
            onClick={() => onDismiss(entry)}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <EyeOff className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="mt-2 flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

interface MessageSuggestFeedEntryCardProps {
  entry: FeedEntry;
  suggest: MessageSuggest;
  busy: boolean;
  error?: string;
  feedData: FeedData;
  onDismiss: (entry: FeedEntry) => void;
  onReportIssue: (entry: FeedEntry, suggest: MessageSuggest) => void;
  onForward: (entry: FeedEntry, suggest: MessageSuggest, conversationId: string) => void;
}

function MessageSuggestFeedEntryCard({
  entry,
  suggest,
  busy,
  error,
  feedData,
  onDismiss,
  onReportIssue,
  onForward,
}: MessageSuggestFeedEntryCardProps) {
  const { t } = useLingui();
  const [expanded, setExpanded] = useState(false);
  const [viewOpen, setViewOpen] = useState(false);
  const title = suggest.text ?? t`Flowpad diagnostics`;
  const body = suggest.message_text ?? '';
  const expandable = body.length > 80 || body.includes('\n');
  const isDiagnosis = suggest.kind !== 'draft_reply';

  const viewButton =
    isDiagnosis && suggest.diagnosis_id ? (
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => setViewOpen(true)}
        className="h-6 gap-1 px-2 text-xs"
      >
        <Eye className="h-3.5 w-3.5" />
        <Trans>View</Trans>
      </Button>
    ) : null;

  return (
    <FeedEntryFrame entry={entry} busy={busy} feedData={feedData} onDismiss={onDismiss}>
      {title && (
        <p className="min-w-0 shrink-0 text-xs font-medium leading-snug text-foreground">{title}</p>
      )}

      {body &&
        (expanded ? (
          <div className="mt-1 flex min-h-0 flex-1 gap-1">
            {expandable && (
              <button
                type="button"
                aria-label={t`Collapse`}
                className="mt-0.5 shrink-0 self-start text-muted-foreground hover:text-foreground"
                onClick={() => setExpanded(false)}
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            )}
            {/* The frame's children wrapper is a flex column, so the body fills the
                remaining height and scrolls — the action row below stays pinned
                inside the card boundary instead of overflowing it. */}
            <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
              <p
                className="cursor-pointer whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground"
                onClick={() => expandable && setExpanded(false)}
              >
                {body}
              </p>
            </div>
          </div>
        ) : (
          <div className="mt-1 flex shrink-0 items-start gap-1">
            {expandable && (
              <button
                type="button"
                aria-label={t`Expand`}
                className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() => setExpanded(true)}
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            )}
            <div className="flex min-w-0 flex-1 items-center gap-1 text-xs text-muted-foreground">
              <span
                className={`truncate ${expandable ? 'cursor-pointer' : ''}`}
                title={body}
                onClick={() => expandable && setExpanded(true)}
              >
                {body}
              </span>
              {expandable && (
                <button
                  type="button"
                  className="shrink-0 text-primary hover:underline"
                  onClick={() => setExpanded(true)}
                >
                  <Trans>more</Trans>
                </button>
              )}
            </div>
          </div>
        ))}

      {suggest.kind === 'draft_reply' && suggest.conversation_id ? (
        <DraftReplyActionButtons
          conversationId={suggest.conversation_id}
          draftFlowMessageId={suggest.flow_message_id}
          onDone={() => onDismiss(entry)}
        />
      ) : (
        <>
          {/* View opens the diagnosis popup, right-most on the Report/Forward row.
              Report/Forward never dismiss the card (only the frame's eye-off does). */}
          {isDiagnosis && suggest.conversation_id ? (
            <DiagnosisActionButtons
              suggestedConversationId={suggest.conversation_id}
              busy={busy}
              error={error}
              showDismiss={false}
              canReport={!!suggest.diagnosis_id}
              onDismiss={() => onDismiss(entry)}
              onReportIssue={() => onReportIssue(entry, suggest)}
              onForward={(conversationId) => onForward(entry, suggest, conversationId)}
              trailing={viewButton}
            />
          ) : (
            viewButton && <div className="mt-2 flex shrink-0 justify-end">{viewButton}</div>
          )}
          {isDiagnosis && suggest.diagnosis_id && (
            <DiagnosisReportModal
              open={viewOpen}
              diagnosisId={suggest.diagnosis_id}
              conversationId={suggest.conversation_id ?? undefined}
              onClose={() => setViewOpen(false)}
            />
          )}
        </>
      )}
    </FeedEntryFrame>
  );
}

interface DraftReplyActionButtonsProps {
  conversationId: string;
  draftFlowMessageId?: string | null;
  /** Hide the card once the user has acted (sent or opened). */
  onDone: () => void;
}

/**
 * Action row for an executed-prompt draft-reply feed card: "Send" (promote the
 * draft to a real reply, then open the conversation) and "Open" (just open the
 * conversation with the draft still pending). Mirrors the feed buttons' sizing.
 */
function DraftReplyActionButtons({ conversationId, draftFlowMessageId, onDone }: DraftReplyActionButtonsProps) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const openConversation = () => navigation.openDock(DockPointer.forConversation(conversationId));

  const handleSend = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (draftFlowMessageId) {
        const fm = await FlowMessage.getById<FlowMessage>(draftFlowMessageId);
        if (fm) await fm.sendDraft();
      }
      openConversation();
      onDone();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed to send draft');
    } finally {
      setBusy(false);
    }
  };

  const handleOpen = () => {
    openConversation();
    onDone();
  };

  return (
    <>
      <div className="mt-2 flex shrink-0 items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() => void handleSend()}
          className="h-6 bg-green-600 px-2 text-xs text-white hover:bg-green-700"
        >
          <Trans>Send</Trans>
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={handleOpen}
          className="h-6 px-2 text-xs"
        >
          <Trans>Open</Trans>
        </Button>
      </div>
      {err && <p className="mt-1 text-xs text-destructive">{err}</p>}
    </>
  );
}

interface UserNoteFeedEntryCardProps {
  entry: FeedEntry;
  note: UserNote;
  busy: boolean;
  feedData: FeedData;
  onDismiss: (entry: FeedEntry) => void;
}

function UserNoteFeedEntryCard({ entry, note, busy, feedData, onDismiss }: UserNoteFeedEntryCardProps) {
  return (
    <FeedEntryFrame entry={entry} busy={busy} feedData={feedData} onDismiss={onDismiss}>
      <div className="max-h-36 overflow-y-auto overscroll-contain">
        <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
          {note.content}
        </p>
      </div>
    </FeedEntryFrame>
  );
}

interface WikiTipFeedEntryCardProps {
  entry: FeedEntry;
  page: Markdown;
  busy: boolean;
  feedData: FeedData;
  onDismiss: (entry: FeedEntry) => void;
}

/**
 * A wiki-page feed entry: a clickable wiki label (click → open, hover → peek
 * the page in a modal) that highlights itself with an onboarding beacon when
 * the URL carries `?highlight=<name>`. The backward half of the WikiTip
 * round-trip. See docs/wikitip.md.
 */
function WikiTipFeedEntryCard({ entry, page, busy, feedData, onDismiss }: WikiTipFeedEntryCardProps) {
  const wikiword =
    (entry.data as { wiki?: string } | null)?.wiki ?? page.name ?? page.title ?? '';
  const { active, phase } = useLingeringHighlight(wikiword);

  return (
    <FeedEntryFrame
      entry={entry}
      busy={busy}
      feedData={feedData}
      onDismiss={onDismiss}
      highlight={active}
      pulsing={phase === 'enter'}
    >
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <WikiLabel wikiword={wikiword} label={wikiword} />
        <span className="text-muted-foreground"><Trans>— open, peek, or get highlighted here</Trans></span>
      </div>
    </FeedEntryFrame>
  );
}

interface AgentTraceFeedEntryCardProps {
  entry: FeedEntry;
  trace: AgentTrace;
  busy: boolean;
  feedData: FeedData;
  onDismiss: (entry: FeedEntry) => void;
}

function AgentTraceFeedEntryCard({ entry, trace, busy, feedData, onDismiss }: AgentTraceFeedEntryCardProps) {
  const { navigation } = useDockNavigation();

  return (
    <FeedEntryFrame entry={entry} busy={busy} feedData={feedData} onDismiss={onDismiss}>
      <button
        type="button"
        className="block w-full rounded text-left outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => navigation.openDock(trace.editorDockPointer)}
      >
        <p className="min-w-0 text-xs font-medium leading-snug text-foreground"><Trans>Skill analysis</Trans></p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          <Trans>Skill analysis ready for review and improvements</Trans>
        </p>
      </button>
    </FeedEntryFrame>
  );
}

interface UsageReportFeedEntryCardProps {
  entry: FeedEntry;
  report: UsageReport;
  busy: boolean;
  feedData: FeedData;
  onDismiss: (entry: FeedEntry) => void;
}

function UsageReportFeedEntryCard({ entry, report, busy, feedData, onDismiss }: UsageReportFeedEntryCardProps) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const day = report.period_start ? report.period_start.slice(0, 10) : '';
  const headline = report.period_kind === 'day' ? t`Yesterday` : t`Last ${report.period_kind}`;

  return (
    <FeedEntryFrame entry={entry} busy={busy} feedData={feedData} onDismiss={onDismiss}>
      <button
        type="button"
        className="block w-full rounded text-left outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => navigation.openDock(report.editorDockPointer)}
      >
        <p className="min-w-0 text-xs font-medium leading-snug text-foreground">
          {headline} usage{day ? ` · ${day}` : ''}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          ${report.total_cost_usd.toFixed(2)} · {report.session_count} sessions ·{' '}
          {formatDuration(report.total_duration_ms)} active · {report.prompt_count} prompts
        </p>
      </button>
    </FeedEntryFrame>
  );
}

interface UnavailableFeedEntryCardProps {
  entry: FeedEntry;
  busy: boolean;
  feedData: FeedData;
  onDismiss: (entry: FeedEntry) => void;
}

function UnavailableFeedEntryCard({ entry, busy, feedData, onDismiss }: UnavailableFeedEntryCardProps) {
  return (
    <FeedEntryFrame entry={entry} busy={busy} feedData={feedData} onDismiss={onDismiss}>
      <p className="min-w-0 text-xs font-medium leading-snug text-foreground"><Trans>Unavailable feed item</Trans></p>
    </FeedEntryFrame>
  );
}
