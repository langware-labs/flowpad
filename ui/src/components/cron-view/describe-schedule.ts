import { parseCron } from './CronForm';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export interface ScheduleDescribeLabels {
  once: (when: string) => string;
  daily: (time: string) => string;
  weekly: (day: string, time: string) => string;
  monthly: (day: string, time: string) => string;
  every: (interval: string) => string;
  cron: (expr: string) => string;
}

/** English labels. Components pass translated ones; tests and fallbacks use these. */
export const ENGLISH_SCHEDULE_LABELS: ScheduleDescribeLabels = {
  once: (when) => `Once at ${when}`,
  daily: (time) => `Daily at ${time}`,
  weekly: (day, time) => `${day} at ${time}`,
  monthly: (day, time) => `Day ${day} of each month at ${time}`,
  every: (interval) => `Every ${interval}`,
  cron: (expr) => `Cron ${expr}`,
};

/**
 * One line a person can read for a schedule — the inverse of `CronForm`'s
 * presets, so a schedule made there reads back the way it was chosen. Anything
 * the presets cannot express (a range like `1-5`) falls back to the raw cron.
 * The zone is appended when it is set, because a schedule travels with its
 * agent to machines in other zones.
 */
export function describeSchedule(
  expr: string | null | undefined,
  kind: string | null | undefined,
  timezone?: string | null,
  labels: ScheduleDescribeLabels = ENGLISH_SCHEDULE_LABELS,
): string {
  const raw = (expr ?? '').trim();
  if (!raw) return '';
  const zone = timezone ? ` (${timezone})` : '';
  if (kind === 'date') return labels.once(raw.replace('T', ' ')) + zone;
  if (kind === 'interval') return labels.every(raw) + zone;

  const parts = raw.split(/\s+/);
  const simple = parts.length === 5 && parts.slice(0, 5).every((p, i) => (i === 3 ? p === '*' : /^(\d+|\*)$/.test(p)));
  if (!simple || parts[0] === '*' || parts[1] === '*') return labels.cron(raw) + zone;
  const parsed = parseCron('cron', raw);
  if (parsed.preset === 'monthly') return labels.monthly(parsed.monthDay, parsed.time) + zone;
  if (parsed.preset === 'weekly') return labels.weekly(WEEKDAYS[Number(parsed.weekDay) % 7] ?? parsed.weekDay, parsed.time) + zone;
  return labels.daily(parsed.time) + zone;
}
