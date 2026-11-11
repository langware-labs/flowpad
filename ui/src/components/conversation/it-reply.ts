import { t } from '@lingui/core/macro';
import type { ItReplyMeta } from '@sdk/entities/agent';

/** The text colour of each reply tone. */
export const TONE: Record<ItReplyView['tone'], string> = {
  ok: 'text-emerald-600 dark:text-emerald-400',
  warn: 'text-amber-600 dark:text-amber-400',
  bad: 'text-red-600 dark:text-red-400',
  muted: 'text-muted-foreground',
};

/** How a machine's IT reply reads: its state pill, and whether it offers "Enable and run" / "Open machine". */
export interface ItReplyView {
  label: string;
  tone: 'ok' | 'warn' | 'bad' | 'muted';
  turnOnAndRun: boolean;
  openMachine: boolean;
}

export function itReplyView(reply: ItReplyMeta): ItReplyView {
  switch (reply.state) {
    case 'done':
      return {
        label: reply.woke ? t`Woke the paused machine · done` : t`IT session · done`,
        tone: 'ok',
        turnOnAndRun: false,
        openMachine: true,
      };
    case 'off':
      return { label: t`IT is disabled on this machine`, tone: 'warn', turnOnAndRun: true, openMachine: false };
    case 'failed':
      // The box ran it and the session failed (the agent errored, the budget refused): the reply text says why.
      return { label: t`IT session failed`, tone: 'bad', turnOnAndRun: false, openMachine: true };
    case 'signed_in':
      return {
        label: t`Not run — someone is signed in on this machine`,
        tone: 'bad',
        turnOnAndRun: false,
        openMachine: false,
      };
    default:
      return { label: t`Unreachable`, tone: 'muted', turnOnAndRun: false, openMachine: true };
  }
}

/** One chip text for a value: a scalar as is, a list by its count, an object by its keys. */
function short(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return String(value.length);
  if (typeof value === 'object') return Object.keys(value).join(', ') || '—';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

/** The returned value's top-level fields, as `name: value` chip texts. */
export function itValueChips(value: ItReplyMeta['value']): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value).map(([k, v]) => `${k}: ${short(v)}`);
}

/** The sender name a machine's reply shows: its code's last four, masked. */
export function itMachineName(reply: ItReplyMeta): string {
  return reply.code_last4 ? `••••${reply.code_last4}` : t`machine`;
}
