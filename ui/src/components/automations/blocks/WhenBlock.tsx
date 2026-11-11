/**
 * "When" — what starts the automation, presets first, the raw form one click away.
 *
 * Schedule: Every day / Weekdays / Weekly / Monthly / Every N / Once, then the
 * cron escape hatch; the next five runs update live. Event: a picker of the
 * events Flowpad knows by name, with the pattern under Advanced. File: a folder
 * or file, an optional pattern, subfolders. Agent: which activity.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import type { BusEventType } from '@sdk';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@src/components/ui/collapsible';
import { Input } from '@src/components/ui/input';
import { useBusMap, useNextRuns } from '@src/hooks/automations/useAutomations';
import { errorMessage } from '@src/lib/error-message';
import { cn } from '@src/lib/utils';
import { scheduleExpr, type AutomationDraft, type EveryUnit, type ScheduleDraft } from '../automation-draft';
import { Pills } from '../Pills';
import { useAutomationWords } from '../automation-words';
import { DateTimeField, TimeZoneControl } from './TimeZonePicker';

const AGENT_HOOK_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStop',
  'Notification',
  'SessionStart',
];

interface BlockProps {
  draft: AutomationDraft;
  onChange: (next: AutomationDraft) => void;
  readOnly?: boolean;
  /** The saved rule in one line; given, the block starts folded to it. */
  summary?: ReactNode;
  defaultOpen?: boolean;
}

/** One block of the page. With a `summary` it folds to one line — title, the summary, an arrow —
 *  and starts folded unless `defaultOpen`; without one it is always open. */
export function Block({
  title,
  children,
  testId,
  aside,
  summary,
  defaultOpen = true,
}: {
  title: ReactNode;
  children: ReactNode;
  testId: string;
  aside?: ReactNode;
  summary?: ReactNode;
  defaultOpen?: boolean;
}) {
  const { t } = useLingui();
  const folds = summary !== undefined;
  const [unfolded, setOpen] = useState(defaultOpen);
  const open = unfolded || !folds;
  return (
    <Collapsible asChild open={open} onOpenChange={setOpen}>
      <section className="rounded-lg border border-border" data-testid={testId} data-open={open}>
        <header
          className={cn(
            'flex items-center gap-3 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground',
            open && 'border-b border-border',
          )}
        >
          <span className={cn(open && 'flex-1')}>{title}</span>
          {open ? (
            aside
          ) : (
            <span
              className="min-w-0 flex-1 truncate text-sm font-normal normal-case tracking-normal text-foreground first-letter:uppercase"
              data-testid={`${testId}-summary`}
            >
              {summary}
            </span>
          )}
          {folds && (
            <CollapsibleTrigger
              aria-label={open ? t`Collapse` : t`Expand`}
              data-testid={`${testId}-toggle`}
              className="flex items-center text-muted-foreground hover:text-foreground"
            >
              {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
            </CollapsibleTrigger>
          )}
        </header>
        <CollapsibleContent className="flex flex-col gap-3 p-4 data-[state=closed]:hidden">{children}</CollapsibleContent>
      </section>
    </Collapsible>
  );
}

export function Advanced({ children, testId }: { children: ReactNode; testId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-testid={testId}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
        <Trans>Advanced</Trans>
      </button>
      {open && <div className="mt-3 flex flex-col gap-3 border-l-2 border-border pl-3">{children}</div>}
    </div>
  );
}

function Field({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

function ScheduleWhenBlock({ draft, onChange, readOnly }: BlockProps) {
  const { t } = useLingui();
  const words = useAutomationWords();
  const s = draft.schedule;
  const set = (patch: Partial<ScheduleDraft>) => onChange({ ...draft, schedule: { ...s, ...patch } });
  const expr = scheduleExpr(s);
  const next = useNextRuns({ expr: expr.expr, sched_trigger_type: expr.sched_trigger_type, timezone: s.timezone });
  const zone = <TimeZoneControl value={s.timezone} disabled={readOnly} onChange={(timezone) => set({ timezone })} />;
  const days = [0, 1, 2, 3, 4, 5, 6].map((d) => ({
    value: String(d),
    label: new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(2026, 9, 4 + d)),
  }));

  return (
    <>
      <Pills
        testId="when-schedule-preset"
        value={s.preset}
        disabled={readOnly}
        onChange={(preset) => set({ preset })}
        options={[
          { value: 'daily', label: t`Every day` },
          { value: 'weekdays', label: t`Weekdays` },
          { value: 'weekly', label: t`Weekly` },
          { value: 'monthly', label: t`Monthly` },
          { value: 'every', label: t`Every few minutes or hours` },
          { value: 'once', label: t`Once` },
          { value: 'cron', label: t`Custom` },
        ]}
      />
      <div className="flex flex-wrap items-end gap-3">
        {['daily', 'weekdays', 'weekly', 'monthly'].includes(s.preset) && (
          <Field label={<Trans>At</Trans>}>
            <Input
              type="time"
              value={s.time}
              disabled={readOnly}
              onChange={(e) => set({ time: e.target.value })}
              className="w-32"
              data-testid="when-schedule-time"
            />
          </Field>
        )}
        {s.preset === 'weekly' && (
          <Field label={<Trans>On</Trans>}>
            <select
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              value={String(s.weekday)}
              disabled={readOnly}
              onChange={(e) => set({ weekday: Number(e.target.value) })}
              data-testid="when-schedule-weekday"
            >
              {days.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          </Field>
        )}
        {s.preset === 'monthly' && (
          <Field label={<Trans>Day of the month</Trans>}>
            <Input
              type="number"
              min={1}
              max={31}
              value={s.monthDay}
              disabled={readOnly}
              onChange={(e) => set({ monthDay: Number(e.target.value) || 1 })}
              className="w-24"
            />
          </Field>
        )}
        {s.preset === 'every' && (
          <>
            <Field label={<Trans>Every</Trans>}>
              <Input
                type="number"
                min={1}
                value={s.everyN}
                disabled={readOnly}
                onChange={(e) => set({ everyN: Number(e.target.value) || 1 })}
                className="w-24"
                data-testid="when-schedule-every-n"
              />
            </Field>
            <Field label={<Trans>Unit</Trans>}>
              <select
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                value={s.everyUnit}
                disabled={readOnly}
                onChange={(e) => set({ everyUnit: e.target.value as EveryUnit })}
                data-testid="when-schedule-every-unit"
              >
                <option value="minutes">{t`minutes`}</option>
                <option value="hours">{t`hours`}</option>
                <option value="days">{t`days`}</option>
              </select>
            </Field>
          </>
        )}
        {s.preset === 'once' && (
          <div className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted-foreground">
              <Trans>On</Trans>
            </span>
            <DateTimeField
              value={s.onceAt}
              disabled={readOnly}
              onChange={(onceAt) => set({ onceAt })}
              zone={s.timezone}
              onZoneChange={(timezone) => set({ timezone })}
            />
          </div>
        )}
        {s.preset === 'cron' && (
          <Field
            label={<Trans>Cron expression</Trans>}
            hint={<Trans>Minute, hour, day of month, month, day of week. 0 and 7 are Sunday.</Trans>}
          >
            <Input
              value={s.cron}
              disabled={readOnly}
              onChange={(e) => set({ cron: e.target.value })}
              className="w-60 font-mono"
              placeholder="0 9 * * 1-5"
              data-testid="when-schedule-cron"
            />
          </Field>
        )}
        {s.preset !== 'once' && s.preset !== 'every' && <div className="pb-1">{zone}</div>}
      </div>

      <div className="text-xs" data-testid="when-next-runs">
        <div className="mb-1 text-muted-foreground">
          <Trans>Next runs</Trans>
        </div>
        {next.error ? (
          <div className="rounded border border-red-500/60 bg-red-500/10 px-2 py-1 text-foreground">
            {errorMessage(next.error, t`That schedule can't be read`)}
          </div>
        ) : next.data?.times.length ? (
          <div className="flex flex-wrap gap-1.5">
            {next.data.times.map((iso) => (
              <span key={iso} className="rounded bg-muted px-2 py-0.5 tabular-nums">
                {words.at(iso)}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground">{next.isFetching ? t`Working it out…` : t`No future run.`}</span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {s.preset === 'once' ? (
          <Trans>Runs while Flowpad is open on this computer. If it was closed at that time, it runs when Flowpad opens again.</Trans>
        ) : (
          <Trans>Runs while Flowpad is open on this computer. A run missed while it was closed is skipped.</Trans>
        )}
      </p>
    </>
  );
}

function EventWhenBlock({ draft, onChange, readOnly }: BlockProps) {
  const { t } = useLingui();
  const { data: map } = useBusMap();
  const [query, setQuery] = useState('');
  const set = (patch: Partial<AutomationDraft['event']>) => onChange({ ...draft, event: { ...draft.event, ...patch } });
  const events = useMemo(
    () =>
      (map?.event_types ?? [])
        .filter((e: BusEventType) => !e.family && !e.pattern_only)
        .filter((e) => !query || `${e.title} ${e.name} ${e.description}`.toLowerCase().includes(query.toLowerCase()))
        .sort((a, b) => Number(!!b.title) - Number(!!a.title) || b.count - a.count || a.name.localeCompare(b.name))
        .slice(0, 40),
    [map, query],
  );
  const chosen = map?.event_types.find((e) => e.name === draft.event.pattern);

  return (
    <>
      <Field label={<Trans>When this happens</Trans>}>
        <Input
          value={query}
          disabled={readOnly}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={chosen ? chosen.title || chosen.name : t`Search events: task, app ready, agent…`}
          data-testid="when-event-search"
        />
      </Field>
      <div className="max-h-56 overflow-auto rounded-md border border-border" role="listbox" aria-label={t`Events`}>
        {events.map((e) => (
          <button
            key={e.name}
            type="button"
            role="option"
            aria-selected={draft.event.pattern === e.name}
            disabled={readOnly}
            data-testid={`when-event-option-${e.name}`}
            onClick={() => set({ pattern: e.name })}
            className={cn(
              'flex w-full items-baseline gap-2 border-t border-border px-3 py-1.5 text-left text-sm first:border-t-0 hover:bg-accent/50',
              draft.event.pattern === e.name && 'bg-primary/10',
            )}
          >
            <span className="min-w-0 flex-1 truncate">{e.title || e.name}</span>
            <code className="shrink-0 font-mono text-[11px] text-muted-foreground">{e.name}</code>
            {e.count > 0 && <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">×{e.count}</span>}
          </button>
        ))}
        {events.length === 0 && (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            <Trans>No known event matches. Type the event name under Advanced.</Trans>
          </div>
        )}
      </div>
      {chosen?.description && <p className="text-xs text-muted-foreground">{chosen.description}</p>}
      <Advanced testId="when-event-advanced">
        <Field
          label={<Trans>Event pattern</Trans>}
          hint={<Trans>Dot-separated; * matches one part, a trailing * matches the rest (task.*).</Trans>}
        >
          <Input
            value={draft.event.pattern}
            disabled={readOnly}
            onChange={(e) => set({ pattern: e.target.value })}
            className="font-mono"
            data-testid="when-event-pattern"
          />
        </Field>
        <Field
          label={<Trans>Only about</Trans>}
          hint={<Trans>A subject such as task:* or data_source:&lt;id&gt;. Empty = any.</Trans>}
        >
          <Input
            value={draft.event.target}
            disabled={readOnly}
            onChange={(e) => set({ target: e.target.value })}
            className="font-mono"
            data-testid="when-event-target"
          />
        </Field>
      </Advanced>
    </>
  );
}

function FileWhenBlock({ draft, onChange, readOnly }: BlockProps) {
  const set = (patch: Partial<AutomationDraft['file']>) => onChange({ ...draft, file: { ...draft.file, ...patch } });
  return (
    <>
      <Field label={<Trans>Watch this file or folder</Trans>} hint={<Trans>A full path under your home folder.</Trans>}>
        <Input
          value={draft.file.path}
          disabled={readOnly}
          onChange={(e) => set({ path: e.target.value })}
          className="font-mono"
          placeholder="/Users/you/Documents/notes"
          data-testid="when-file-path"
        />
      </Field>
      <div className="flex flex-wrap items-end gap-4">
        <Field label={<Trans>Only files like</Trans>}>
          <Input
            value={draft.file.glob}
            disabled={readOnly}
            onChange={(e) => set({ glob: e.target.value })}
            className="w-40 font-mono"
            placeholder="*.md"
            data-testid="when-file-glob"
          />
        </Field>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            checked={draft.file.recursive}
            disabled={readOnly}
            onChange={(e) => set({ recursive: e.target.checked })}
            data-testid="when-file-recursive"
          />
          <Trans>Include subfolders</Trans>
        </label>
      </div>
    </>
  );
}

function HookWhenBlock({ draft, onChange, readOnly }: BlockProps) {
  const toggle = (name: string) => {
    const events = draft.hook.events.includes(name)
      ? draft.hook.events.filter((e) => e !== name)
      : [...draft.hook.events, name];
    onChange({ ...draft, hook: { events } });
  };
  return (
    <div className="flex flex-wrap gap-2" data-testid="when-hook-events">
      {AGENT_HOOK_EVENTS.map((name) => (
        <label key={name} className="flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs">
          <input
            type="checkbox"
            checked={draft.hook.events.includes(name)}
            disabled={readOnly}
            onChange={() => toggle(name)}
          />
          <code className="font-mono">{name}</code>
        </label>
      ))}
    </div>
  );
}

export function WhenBlock(props: BlockProps) {
  const words = useAutomationWords();
  const body =
    props.draft.kind === 'schedule' ? (
      <ScheduleWhenBlock {...props} />
    ) : props.draft.kind === 'event' ? (
      <EventWhenBlock {...props} />
    ) : props.draft.kind === 'file' ? (
      <FileWhenBlock {...props} />
    ) : (
      <HookWhenBlock {...props} />
    );
  return (
    <Block
      testId="automation-when"
      title={<Trans>When</Trans>}
      summary={props.summary}
      defaultOpen={props.defaultOpen}
      aside={<span className="normal-case tracking-normal">{words.kind(props.draft.kind)}</span>}
    >
      {body}
    </Block>
  );
}
