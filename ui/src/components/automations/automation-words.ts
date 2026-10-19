/**
 * Everything the Automations screen SAYS, in the person's language.
 *
 * The backend answers structured parts (`WhenPart`, `ThenPart`, a run's status);
 * this turns them into words through lingui, so Hebrew and Arabic read as
 * naturally as English. `text` from the backend is only a fallback for a part
 * this file does not know yet.
 */
import { useLingui } from '@lingui/react/macro';
import { useMemo } from 'react';
import { isMessagePattern, type AutomationKind, type AutomationRun, type RunStatus, type ScheduleWhen, type ThenPart, type WhenPart } from '@sdk';

export interface AutomationWords {
  kind: (kind: AutomationKind) => string;
  kindPlural: (kind: AutomationKind) => string;
  /** One word: Schedule, Event, File, Agent. */
  kindShort: (kind: AutomationKind) => string;
  when: (when: WhenPart) => string;
  schedule: (schedule: ScheduleWhen) => string;
  then: (part: ThenPart) => string;
  status: (status: RunStatus) => string;
  why: (run: AutomationRun) => string;
  /** "today 09:00", "yesterday 18:12", "Mon 12 Oct 09:00". */
  at: (iso: string | null | undefined) => string;
  duration: (ms: number | null | undefined) => string;
}

/** A path as its last two parts ("…/docs/notes") — the full one is long and says less. */
export function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path;
}

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function useAutomationWords(): AutomationWords {
  const { t, i18n } = useLingui();
  return useMemo(() => {
    const locale = i18n.locale || undefined;
    const clock = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
    const dayName = (d: number) =>
      new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(new Date(2026, 9, 4 + d)); // 4 Oct 2026 is a Sunday
    const longDay = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' });

    const every = (seconds: number) => {
      if (seconds % 86400 === 0) {
        const n = seconds / 86400;
        return n === 1 ? t`Every day` : t`Every ${n} days`;
      }
      if (seconds % 3600 === 0) {
        const n = seconds / 3600;
        return n === 1 ? t`Every hour` : t`Every ${n} hours`;
      }
      if (seconds % 60 === 0) {
        const n = seconds / 60;
        return n === 1 ? t`Every minute` : t`Every ${n} minutes`;
      }
      return t`Every ${seconds} seconds`;
    };

    const schedule = (s: ScheduleWhen): string => {
      const time = s.time ?? '';
      let text: string;
      switch (s.preset) {
        case 'daily':
          text = t`Every day at ${time}`;
          break;
        case 'weekdays':
          text = t`Every weekday at ${time}`;
          break;
        case 'weekly': {
          const day = dayName(s.weekday ?? 0);
          text = t`Every ${day} at ${time}`;
          break;
        }
        case 'monthly': {
          const day = s.month_day ?? 1;
          text = t`On day ${day} of each month at ${time}`;
          break;
        }
        case 'every':
          text = every(s.interval_seconds ?? 0);
          break;
        case 'once': {
          const when = s.expr.replace('T', ' ');
          text = t`Once, at ${when}`;
          break;
        }
        default: {
          const expr = s.expr;
          text = t`On the schedule ${expr}`;
        }
      }
      return s.timezone ? `${text} (${s.timezone})` : text;
    };

    const when = (w: WhenPart): string => {
      if (w.kind === 'schedule' && w.schedule) return schedule(w.schedule);
      if (w.kind === 'event' && w.event) {
        if (isMessagePattern(w.event.pattern)) return t`When a message arrives`;
        const what = w.event.title || w.event.pattern;
        return t`When ${what} happens`;
      }
      if (w.kind === 'file' && w.file) {
        const folder = shortPath(w.file.path);
        const what = w.file.glob ? t`${w.file.glob} in ${folder}` : folder;
        return t`When ${what} changes`;
      }
      if (w.kind === 'agent_hook') {
        const events = w.hook?.events?.join(', ') || t`anything`;
        return t`When an agent reports ${events}`;
      }
      return w.text;
    };

    const then = (p: ThenPart): string => {
      const name = p.target_name ?? '';
      switch (p.kind) {
        case 'run_agent':
          return name ? t`run ${name}` : t`run an agent`;
        case 'open_wizard':
          return name ? t`open ${name}` : t`open a setup wizard`;
        case 'run_script':
          return name ? t`run the script ${name.split('/').pop()}` : t`run a script`;
        case 'notify':
          return name ? t`notify ${name}` : t`send a notification`;
        case 'workflow':
          return t`start the workflow ${name}`;
        case 'builtin_step':
          return t`run the built-in step ${name}`;
        case 'nothing':
          return t`do nothing yet`;
        default:
          return p.text;
      }
    };

    const status = (s: RunStatus): string =>
      ({
        running: t`Running`,
        launched: t`Started`,
        succeeded: t`Succeeded`,
        failed: t`Failed`,
        skipped: t`Skipped`,
      })[s] ?? s;

    const skip = (code: string | null | undefined): string | null => {
      switch (code) {
        case 'storm':
          return t`Skipped: it fired too often in one minute`;
        case 'confirm_failed':
          return t`Skipped: the check before running found nothing`;
        case 'disabled':
          return t`Skipped: the automation was off`;
        case 'self_loop':
          return t`Skipped: it would have triggered itself`;
        case 'already_fired':
          return t`Skipped: it only runs once, and it already ran`;
        default:
          return null;
      }
    };

    const why = (run: AutomationRun): string => {
      const skipped = skip(run.reason_code);
      if (skipped) return skipped;
      let base: string;
      if (run.kind === 'schedule') base = t`Scheduled`;
      else if (run.kind === 'file' && run.changed_path) {
        const path = run.changed_path;
        const n = run.changes_total ?? 1;
        base = n > 1 ? t`${n} files changed, first ${path}` : t`A file changed: ${path}`;
      } else base = run.why; // an event's catalog title or an agent hook's name, from the backend
      return run.is_test ? t`Test run: ${base}` : base;
    };

    const at = (iso: string | null | undefined): string => {
      if (!iso) return '';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      const now = new Date();
      const hhmm = clock.format(d);
      if (sameDay(d, now)) return t`today ${hhmm}`;
      const yesterday = new Date(now);
      yesterday.setDate(now.getDate() - 1);
      if (sameDay(d, yesterday)) return t`yesterday ${hhmm}`;
      const day = longDay.format(d);
      return `${day} ${hhmm}`;
    };

    const duration = (ms: number | null | undefined): string => {
      if (ms == null) return '';
      if (ms < 1000) return t`${ms} ms`;
      const s = Math.round(ms / 1000);
      if (s < 60) return t`${s}s`;
      const m = Math.floor(s / 60);
      const rest = s % 60;
      return t`${m}m ${rest}s`;
    };

    const kind = (k: AutomationKind): string =>
      ({
        schedule: t`On a schedule`,
        event: t`When something happens in Flowpad`,
        file: t`When a file changes`,
        agent_hook: t`When an agent does something`,
      })[k];

    const kindPlural = (k: AutomationKind): string =>
      ({
        schedule: t`On a schedule`,
        event: t`When something happens`,
        file: t`When a file changes`,
        agent_hook: t`When an agent does something`,
      })[k];

    const kindShort = (k: AutomationKind): string =>
      ({
        schedule: t`Schedule`,
        event: t`Event`,
        file: t`File`,
        agent_hook: t`Agent`,
      })[k];

    return { kind, kindPlural, kindShort, when, schedule, then, status, why, at, duration };
  }, [t, i18n.locale]);
}

/** The full sentence for a list row: "Every weekday at 09:00 → run Chief of Staff". */
export function sentenceOf(words: AutomationWords, when: WhenPart, then: ThenPart[]): { when: string; then: string } {
  return { when: words.when(when), then: then.map(words.then).join(', ') };
}

/** The sentence on one line: "Every weekday at 09:00 → run Chief of Staff". */
export function sentenceText(words: AutomationWords, when: WhenPart, then: ThenPart[]): string {
  const s = sentenceOf(words, when, then);
  return `${s.when} → ${s.then}`;
}
