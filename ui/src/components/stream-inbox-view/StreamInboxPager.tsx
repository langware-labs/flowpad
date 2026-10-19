import { useEffect, useMemo, useState } from 'react';
import { Trans } from '@lingui/react/macro';
import { ChevronLeft, ChevronRight, ChevronsLeft } from 'lucide-react';
import { Conversation, QueryRequest } from '@sdk';
import { Button } from '@src/components/ui/button';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { loadOlderConversations } from './stream-inbox-api';
import {
  type ConversationScope,
  newerBoundaryRequest,
  scopeKey,
  STREAM_INBOX_PAGE_SIZE,
  type StreamInboxViewMode,
} from './channel-owner';

/** An entity date as the ISO string a keyset compares on. */
function isoOf(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const idle = new QueryRequest({ type: Conversation.type, name: 'stream-inbox:pager-idle' });

/**
 * Now + the latest page, and back from there. The page is the dock URL's `before` (null = now), so
 * every button only navigates: Older is the oldest row shown, Newer is worked out ahead by a small
 * query over the rows just above this page, Now drops `before`.
 */
export function StreamInboxPager({
  scope,
  view,
  rows,
}: {
  scope: ConversationScope;
  view: StreamInboxViewMode;
  /** The page shown, newest first. */
  rows: Conversation[];
}) {
  const { navigation, currentDock } = useDockNavigation();
  const before = currentDock?.pageBefore ?? null;
  const newest = isoOf(rows[0]?.updated_date);
  const oldest = isoOf(rows[rows.length - 1]?.updated_date);

  const newerRequest = useMemo(
    () => (before && newest ? newerBoundaryRequest(scope, view, newest) : null),
    [before, newest, scope, view],
  );
  const { data: above = [] } = useEntitiesQuery<Conversation>(newerRequest ?? idle, { enabled: newerRequest !== null });
  // No row a page + 1 above: the newer page is now.
  const newerBefore = isoOf(above[0]?.updated_date);

  // An older page the store cannot fill asks the sources, once per page: one page each, older than
  // what is shown (or than the page's bound when nothing is). What arrives joins this live page.
  const short = !!before && rows.length < STREAM_INBOX_PAGE_SIZE && view !== 'archived';
  const askBefore = oldest ?? before;
  const askKey = short && askBefore ? `${scopeKey(scope)}|${view}|${askBefore}` : null;
  const [asked, setAsked] = useState<{ key: string; status: 'loading' | 'more' | 'exhausted' } | null>(null);
  useEffect(() => {
    if (!askKey || !askBefore) return;
    let stale = false;
    setAsked({ key: askKey, status: 'loading' });
    void loadOlderConversations(askBefore, scope).then(
      (result) => !stale && setAsked({ key: askKey, status: result.exhausted ? 'exhausted' : 'more' }),
      () => !stale && setAsked({ key: askKey, status: 'more' }),
    );
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on askKey
  }, [askKey]);
  const status = askKey && asked?.key === askKey ? asked.status : null;

  // Older stays offered while there is a row to step back from, until the sources say nothing is left.
  const hasOlder = !!oldest && status !== 'exhausted' && status !== 'loading';
  if (!currentDock || (!before && !oldest)) return null;

  const go = (next: string | null) => navigation.openDock(currentDock.withPageBefore(next));
  return (
    <div className="flex items-center justify-center gap-2 py-3" data-testid="stream-inbox-pager">
      {before && (
        <>
          <Button variant="ghost" size="sm" onClick={() => go(null)} data-testid="stream-inbox-page-now">
            <ChevronsLeft className="me-1 h-3.5 w-3.5 rtl:rotate-180" />
            <Trans>Now</Trans>
          </Button>
          <Button variant="outline" size="sm" onClick={() => go(newerBefore)} data-testid="stream-inbox-page-newer">
            <ChevronLeft className="me-1 h-3.5 w-3.5 rtl:rotate-180" />
            <Trans>Newer</Trans>
          </Button>
        </>
      )}
      {status === 'loading' && (
        <span className="text-xs text-muted-foreground" data-testid="stream-inbox-page-loading">
          <Trans>Fetching older messages…</Trans>
        </span>
      )}
      {status === 'exhausted' && rows.length === 0 && (
        <span className="text-xs text-muted-foreground" data-testid="stream-inbox-page-exhausted">
          <Trans>No older conversations</Trans>
        </span>
      )}
      <Button
        variant="outline"
        size="sm"
        disabled={!hasOlder}
        onClick={() => go(oldest)}
        data-testid="stream-inbox-page-older"
      >
        <Trans>Older</Trans>
        <ChevronRight className="ms-1 h-3.5 w-3.5 rtl:rotate-180" />
      </Button>
    </div>
  );
}
