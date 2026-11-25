export interface IcsAttendee {
  name: string;
  /** RFC 5545 PARTSTAT, lower-cased (`needs-action`, `accepted`, `declined`, `tentative`); '' when absent. */
  status: string;
}

/** One event of an iCalendar (`.ics`) file, reduced to what the viewer shows. */
export interface IcsEvent {
  title: string;
  start: Date;
  end: Date | null;
  /** A date with no time of day. */
  allDay: boolean;
  /** The zone the sender scheduled in (`America/Chicago`); null for UTC and floating times. */
  zone: string | null;
  location: string;
  description: string;
  /** The first http(s) link the event carries (its URL, else its location) — where to join. */
  link: string | null;
  organizer: string;
  attendees: IcsAttendee[];
  recurring: boolean;
}

const HTTP_RE = /^https?:\/\/\S+$/i;

/** A person property (ORGANIZER, ATTENDEE) as its display name, else its address without `mailto:`. */
const who = (person: { getParameter(name: string): unknown; getFirstValue(): unknown }): string =>
  String(person.getParameter('cn') ?? '') || String(person.getFirstValue() ?? '').replace(/^mailto:/i, '');

/**
 * Every VEVENT of an `.ics` text, in file order. Throws on text that is not iCalendar.
 * The parser (`ical.js`) is loaded on first use, so it costs nothing until a calendar file is opened.
 */
export async function parseIcs(text: string): Promise<IcsEvent[]> {
  const { default: ICAL } = await import('ical.js');
  const calendar = new ICAL.Component(ICAL.parse(text));
  return calendar.getAllSubcomponents('vevent').map((vevent) => {
    const event = new ICAL.Event(vevent);
    const start = event.startDate;
    const organizer = vevent.getFirstProperty('organizer');
    const url = String(vevent.getFirstPropertyValue('url') ?? '');
    const location = event.location ?? '';
    const tzid = start.zone?.tzid;
    return {
      title: event.summary ?? '',
      start: start.toJSDate(),
      end: event.endDate ? event.endDate.toJSDate() : null,
      allDay: start.isDate,
      zone: tzid && tzid !== 'UTC' && tzid !== 'floating' ? tzid : null,
      location,
      description: event.description ?? '',
      link: [url, location].find((v) => HTTP_RE.test(v)) ?? null,
      organizer: organizer ? who(organizer) : '',
      attendees: event.attendees.map((a) => ({
        name: who(a),
        status: String(a.getParameter('partstat') ?? '').toLowerCase(),
      })),
      recurring: event.isRecurring(),
    };
  });
}
