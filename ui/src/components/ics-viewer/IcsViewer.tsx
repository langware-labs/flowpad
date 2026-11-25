import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { FSRef } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { CalendarDays, ExternalLink, MapPin, Repeat, User, Users, type LucideIcon } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { Card } from '@src/components/ui/card';
import { useDownloadUrl } from '@src/hooks/use-download-url';
import { useFSRefContent } from '@src/hooks/use-fs-ref-content';
import { openExternal } from '@src/lib/open-external';
import { parseIcs, type IcsEvent } from './parse-ics';

/** "Wed, Dec 2, 2026, 5:00 – 6:30 PM" in the reader's own time zone (or `timeZone` when given). */
function when(event: IcsEvent, locale: string | undefined, timeZone?: string): string {
  const fmt = new Intl.DateTimeFormat(locale, {
    dateStyle: 'full',
    // An all-day date is a calendar day, not an instant: ical.js builds it at local midnight.
    ...(event.allDay ? {} : { timeStyle: 'short', timeZone }),
  });
  // An all-day DTEND is exclusive, so a one-day event has nothing to show after the dash.
  const end = event.allDay ? null : event.end;
  return end ? fmt.formatRange(event.start, end) : fmt.format(event.start);
}

/** One fact of the event: its icon, then the text. */
function Row({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      {children}
    </div>
  );
}

function EventCard({ event }: { event: IcsEvent }) {
  const { t, i18n } = useLingui();
  const locale = i18n.locale || undefined;
  const answers: Record<string, string> = {
    accepted: t`Accepted`,
    declined: t`Declined`,
    tentative: t`Maybe`,
    'needs-action': t`Not answered`,
  };
  return (
    <Card dir="auto" className="p-5 text-sm" data-testid="ics-event">
      <h2 className="text-lg font-semibold">{event.title || <Trans>Untitled event</Trans>}</h2>
      <dl className="mt-4 space-y-3">
        <Row icon={CalendarDays}>
          <div>
            <dd data-testid="ics-event-when">{when(event, locale)}</dd>
            {event.zone && !event.allDay && (
              <dd className="text-xs text-muted-foreground">
                {when(event, locale, event.zone)} ({event.zone})
              </dd>
            )}
          </div>
        </Row>
        {event.recurring && (
          <Row icon={Repeat}>
            <dd>
              <Trans>Repeats</Trans>
            </dd>
          </Row>
        )}
        {event.location && event.location !== event.link && (
          <Row icon={MapPin}>
            <dd>{event.location}</dd>
          </Row>
        )}
        {event.organizer && (
          <Row icon={User}>
            <dd>
              <Trans>Organized by {event.organizer}</Trans>
            </dd>
          </Row>
        )}
        {event.attendees.length > 0 && (
          <Row icon={Users}>
            <dd>
              <ul className="space-y-1">
                {event.attendees.map((a, i) => (
                  <li key={`${a.name}-${i}`}>
                    {a.name}
                    {answers[a.status] && <span className="text-muted-foreground"> · {answers[a.status]}</span>}
                  </li>
                ))}
              </ul>
            </dd>
          </Row>
        )}
      </dl>
      {event.description && (
        <p className="mt-4 whitespace-pre-wrap break-words text-muted-foreground">{event.description}</p>
      )}
      {event.link && (
        <Button className="mt-4" onClick={() => openExternal(event.link!)} data-testid="ics-event-link">
          <ExternalLink />
          <Trans>Open link</Trans>
        </Button>
      )}
    </Card>
  );
}

/** Read-only view of an iCalendar file by path (like DocxViewer): each event it holds, as a card. */
export function IcsViewer({ path }: { path: string }) {
  const { subPath, typeId, revision } = useDownloadUrl(path);
  const fsRef = useMemo(() => (typeId ? new FSRef(subPath, typeId) : null), [subPath, typeId]);
  const { content, isLoading, loadError, isMissing } = useFSRefContent(fsRef, { autoSave: false, reloadKey: revision });
  const [events, setEvents] = useState<IcsEvent[] | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const loaded = !!fsRef && !isLoading && !loadError && !isMissing;

  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    setParseError(null);
    parseIcs(content)
      .then((found) => !cancelled && setEvents(found))
      .catch((err: unknown) => !cancelled && setParseError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [loaded, content]);

  const error = loadError?.message ?? parseError ?? (!fsRef || isMissing ? path : null);
  if (error) {
    return (
      <div className="m-6 rounded-md border border-destructive bg-destructive/10 p-4 text-sm text-foreground">
        <Trans>Could not open this calendar file: {error}</Trans>
      </div>
    );
  }
  if (events === null) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        <Trans>Loading…</Trans>
      </div>
    );
  }
  return (
    <div className="h-full overflow-auto bg-background" data-testid="ics-viewer">
      <div className="mx-auto max-w-2xl space-y-4 px-8 py-6">
        {events.length === 0 && (
          <p className="text-sm text-muted-foreground">
            <Trans>This calendar file has no events.</Trans>
          </p>
        )}
        {events.map((event, i) => (
          <EventCard key={i} event={event} />
        ))}
      </div>
    </div>
  );
}

export default IcsViewer;
