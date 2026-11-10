/** Time zones in words: this computer's zone, a zone as `New York · UTC−5`, the list to pick from. */

let here: string | undefined;
/** This computer's zone (resolved once: it does not change under a running app). */
export const localZone = () => (here ??= Intl.DateTimeFormat().resolvedOptions().timeZone);

const city = (zone: string) => (zone.split('/').pop() ?? zone).replace(/_/g, ' ');

const offsets = new Map<string, string>();

/** `UTC−5`, or `` for a zone the browser does not know. */
export function zoneOffset(zone: string): string {
  let offset = offsets.get(zone);
  if (offset === undefined) {
    try {
      const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' })
        .formatToParts(new Date())
        .find((p) => p.type === 'timeZoneName')?.value;
      // `GMT` alone or `GMT+0` (ICU builds differ) are both just UTC.
      offset = (part ?? '').replace('GMT', 'UTC').replace('-', '−').replace(/^UTC[+−]0$/, 'UTC') || 'UTC';
    } catch {
      offset = '';
    }
    offsets.set(zone, offset);
  }
  return offset;
}

/** `New York · UTC−5` */
export const zoneLabel = (zone: string) => [city(zone), zoneOffset(zone)].filter(Boolean).join(' · ');

let known: string[] | undefined;
/** Every zone the browser knows, UTC first — built on first use. */
export const knownZones = () => (known ??= [...new Set(['UTC', ...Intl.supportedValuesOf('timeZone')])]);

/** A one-time schedule's `YYYY-MM-DDTHH:mm…` as the day and time it was set to: `Nov 10, 2026` + `15:35`. */
export function onceParts(
  expr: string,
  locale?: string,
): { day: string; date: Date | undefined; time: string; label: string } {
  const [day = '', time = ''] = expr.slice(0, 16).split('T');
  const stamp = new Date(`${day}T00:00`);
  const date = Number.isNaN(stamp.getTime()) ? undefined : stamp;
  return { day, date, time, label: date ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date) : day };
}
