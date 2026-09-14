/**
 * The one-line reading of a schedule — the inverse of CronForm's presets.
 */
import { describe, expect, it } from 'vitest';
import { buildCron } from '@src/components/cron-view/CronForm';
import { describeSchedule } from '@src/components/cron-view/describe-schedule';

describe('describeSchedule', () => {
  it('reads back each preset the way it was chosen', () => {
    expect(describeSchedule(buildCron('daily', '09:05', '1', '1', '', '').expr, 'cron')).toBe('Daily at 09:05');
    // Crontab weekday: 0 = Sunday.
    expect(describeSchedule(buildCron('weekly', '18:30', '0', '1', '', '').expr, 'cron')).toBe('Sun at 18:30');
    expect(describeSchedule(buildCron('monthly', '07:00', '1', '15', '', '').expr, 'cron')).toBe('Day 15 of each month at 07:00');
    expect(describeSchedule('2026-09-15T09:00:00', 'date')).toBe('Once at 2026-09-15 09:00:00');
  });

  it('keeps anything the presets cannot express as the raw cron', () => {
    expect(describeSchedule('0 9 * * 1-5', 'cron')).toBe('Cron 0 9 * * 1-5');
    expect(describeSchedule('* * * * *', 'cron')).toBe('Cron * * * * *');
    expect(describeSchedule('5m', 'interval')).toBe('Every 5m');
  });

  it('names the zone, because a schedule travels to machines in other zones', () => {
    expect(describeSchedule('0 9 * * *', 'cron', 'Asia/Jerusalem')).toBe('Daily at 09:00 (Asia/Jerusalem)');
  });

  it('is empty for no schedule', () => {
    expect(describeSchedule('', 'cron')).toBe('');
    expect(describeSchedule(undefined, undefined)).toBe('');
  });
});
