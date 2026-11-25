/**
 * `parseIcs` is what the `.ics` viewer shows: a meeting invite's event, with its
 * start resolved through the file's own VTIMEZONE to a real instant.
 */
import { describe, expect, it } from 'vitest';
import { parseIcs } from '@src/components/ics-viewer/parse-ics';

const INVITE = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'METHOD:REQUEST',
  'BEGIN:VTIMEZONE',
  'TZID:America/Chicago',
  'BEGIN:STANDARD',
  'TZNAME:CST',
  'TZOFFSETFROM:-0600',
  'TZOFFSETTO:-0600',
  'DTSTART:19700101T000000',
  'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'UID:1@example.com',
  'DTSTAMP:20261125T101617',
  'DTSTART;TZID=America/Chicago:20261202T090000',
  'DTEND;TZID=America/Chicago:20261202T103000',
  'SUMMARY:Recording session',
  'LOCATION:https://example.com/studio/abc',
  'DESCRIPTION:Join from your browser\\, no download.',
  'ORGANIZER;CN="Dana":mailto:events@example.com',
  'ATTENDEE;PARTSTAT=NEEDS-ACTION;CN="Guest":MAILTO:guest@example.com',
  'ATTENDEE;PARTSTAT=ACCEPTED:mailto:host@example.com',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('parseIcs', () => {
  it('reads an invite: the instant, the join link, who organized and who answered', async () => {
    const [event] = await parseIcs(INVITE);
    expect(event.title).toBe('Recording session');
    expect(event.start.toISOString()).toBe('2026-12-02T15:00:00.000Z');
    expect(event.end?.toISOString()).toBe('2026-12-02T16:30:00.000Z');
    expect(event.zone).toBe('America/Chicago');
    expect(event.allDay).toBe(false);
    expect(event.link).toBe('https://example.com/studio/abc');
    expect(event.description).toBe('Join from your browser, no download.');
    expect(event.organizer).toBe('Dana');
    expect(event.attendees).toEqual([
      { name: 'Guest', status: 'needs-action' },
      { name: 'host@example.com', status: 'accepted' },
    ]);
    expect(event.recurring).toBe(false);
  });

  it('rejects text that is not a calendar', async () => {
    await expect(parseIcs('hello')).rejects.toThrow();
  });
});
