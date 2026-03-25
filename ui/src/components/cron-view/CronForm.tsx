import { useState } from 'react';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import type { ICronEvent } from '@sdk';

// ── Types ─────────────────────────────────────────────────────────────────────

type Preset = 'once' | 'daily' | 'weekly' | 'monthly' | 'custom';

const PRESETS: { id: Preset; label: string }[] = [
  { id: 'once',    label: 'Once'    },
  { id: 'daily',   label: 'Daily'   },
  { id: 'weekly',  label: 'Weekly'  },
  { id: 'monthly', label: 'Monthly' },
  { id: 'custom',  label: 'Custom'  },
];

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
// APScheduler/cron day-of-week: 0=Mon … 6=Sun (same as Python)
const DAY_VALUES = ['1', '2', '3', '4', '5', '6', '0'];

// ── Cron builder ──────────────────────────────────────────────────────────────

function buildCron(preset: Preset, time: string, weekDay: string, monthDay: string, customExpr: string, runAt: string): Pick<ICronEvent, 'expr' | 'trigger_type'> {
  const [h = '9', m = '0'] = time.split(':');
  const min = String(parseInt(m, 10));
  const hr  = String(parseInt(h, 10));
  switch (preset) {
    case 'once':    return { trigger_type: 'date',     expr: runAt };
    case 'daily':   return { trigger_type: 'cron',     expr: `${min} ${hr} * * *` };
    case 'weekly':  return { trigger_type: 'cron',     expr: `${min} ${hr} * * ${weekDay}` };
    case 'monthly': return { trigger_type: 'cron',     expr: `${min} ${hr} ${monthDay} * *` };
    case 'custom':  return { trigger_type: 'cron',     expr: customExpr };
  }
}

function parseCron(trigger_type?: string, expr?: string): { preset: Preset; time: string; weekDay: string; monthDay: string } {
  if (trigger_type === 'date') return { preset: 'once', time: '09:00', weekDay: '1', monthDay: '1' };
  if (!expr) return { preset: 'daily', time: '09:00', weekDay: '1', monthDay: '1' };
  const parts = expr.split(' ');
  if (parts.length === 5) {
    const [min, hr, dom, , dow] = parts;
    const time = `${hr.padStart(2, '0')}:${min.padStart(2, '0')}`;
    if (dom !== '*' && dom !== '?' ) return { preset: 'monthly', time, weekDay: '1', monthDay: dom };
    if (dow !== '*' && dow !== '?' ) return { preset: 'weekly',  time, weekDay: dow, monthDay: '1' };
    return { preset: 'daily', time, weekDay: '1', monthDay: '1' };
  }
  return { preset: 'custom', time: '09:00', weekDay: '1', monthDay: '1' };
}

// ── Sub-component: compact segmented control ──────────────────────────────────

function SegmentedControl({ options, value, onChange }: {
  options: { id: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex rounded border bg-muted/40 p-0.5 gap-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          className={[
            'flex-1 rounded px-1.5 py-0.5 text-[11px] font-medium transition-all',
            value === o.id
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          ].join(' ')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Sub-component: compact time row ──────────────────────────────────────────

function TimeRow({ preset, time, onTimeChange, weekDay, onWeekDayChange, monthDay, onMonthDayChange, runAt, onRunAtChange, customExpr, onCustomExprChange }: {
  preset: Preset;
  time: string; onTimeChange: (v: string) => void;
  weekDay: string; onWeekDayChange: (v: string) => void;
  monthDay: string; onMonthDayChange: (v: string) => void;
  runAt: string; onRunAtChange: (v: string) => void;
  customExpr: string; onCustomExprChange: (v: string) => void;
}) {
  if (preset === 'once') {
    return (
      <input
        type="datetime-local"
        value={runAt}
        onChange={(e) => onRunAtChange(e.target.value)}
        required
        className="w-full rounded border bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
      />
    );
  }

  if (preset === 'custom') {
    return (
      <div className="flex flex-col gap-0.5">
        <input
          value={customExpr}
          onChange={(e) => onCustomExprChange(e.target.value)}
          placeholder="* * * * *"
          required
          className="w-full rounded border bg-background px-2 py-1 font-mono text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <p className="text-[10px] text-muted-foreground">min hr dom mon dow — or "30s" / "5m" for interval</p>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      {/* Day selector for weekly */}
      {preset === 'weekly' && (
        <div className="flex rounded border bg-muted/40 p-0.5 gap-0.5">
          {DAYS.map((d, i) => (
            <button
              key={d}
              type="button"
              onClick={() => onWeekDayChange(DAY_VALUES[i])}
              className={[
                'rounded px-1.5 py-0.5 text-[10px] font-medium transition-all',
                weekDay === DAY_VALUES[i]
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              ].join(' ')}
            >
              {d}
            </button>
          ))}
        </div>
      )}

      {/* Month-day selector */}
      {preset === 'monthly' && (
        <select
          value={monthDay}
          onChange={(e) => onMonthDayChange(e.target.value)}
          className="rounded border bg-background px-1.5 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        >
          {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
            <option key={d} value={String(d)}>Day {d}</option>
          ))}
        </select>
      )}

      {/* Time */}
      <input
        type="time"
        value={time}
        onChange={(e) => onTimeChange(e.target.value)}
        className="rounded border bg-background px-1.5 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
      />
    </div>
  );
}

// ── Main form ─────────────────────────────────────────────────────────────────

interface CronFormProps {
  initial?: Partial<ICronEvent>;
  defaultName?: string;
  onSubmit: (data: Partial<ICronEvent>) => Promise<void>;
  onCancel: () => void;
  submitting?: boolean;
}

export function CronForm({ initial = {}, defaultName = 'Today', onSubmit, onCancel, submitting }: CronFormProps) {
  const parsed = parseCron(initial.trigger_type, initial.expr);

  const [name, setName]             = useState(initial.name ?? defaultName);
  const [description, setDesc]      = useState(initial.description ?? '');
  const [preset, setPreset]         = useState<Preset>(parsed.preset);
  const [time, setTime]             = useState(parsed.time);
  const [weekDay, setWeekDay]       = useState(parsed.weekDay);
  const [monthDay, setMonthDay]     = useState(parsed.monthDay);
  const [customExpr, setCustomExpr] = useState(
    parsed.preset === 'custom' && initial.expr ? initial.expr : '* * * * *'
  );
  const [runAt, setRunAt] = useState(() => {
    if (initial.trigger_type === 'date' && initial.expr) return initial.expr;
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d.toISOString().slice(0, 16);
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const fields = buildCron(preset, time, weekDay, monthDay, customExpr, runAt);
    await onSubmit({ name, description: description || undefined, ...fields, enabled: true });
  };

  return (
    <form onSubmit={(e) => { void handleSubmit(e); }} className="flex flex-col gap-2.5 p-4">

      {/* Name + description */}
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Today"
        required
        className="h-7 text-xs"
      />
      <Input
        value={description}
        onChange={(e) => setDesc(e.target.value)}
        placeholder="Description like prepare my daily brief"
        className="h-7 text-xs"
      />

      {/* Interval row */}
      <SegmentedControl
        options={PRESETS}
        value={preset}
        onChange={(v) => setPreset(v as Preset)}
      />

      {/* Time / date row */}
      <TimeRow
        preset={preset}
        time={time} onTimeChange={setTime}
        weekDay={weekDay} onWeekDayChange={setWeekDay}
        monthDay={monthDay} onMonthDayChange={setMonthDay}
        runAt={runAt} onRunAtChange={setRunAt}
        customExpr={customExpr} onCustomExprChange={setCustomExpr}
      />

      {/* Actions */}
      <div className="flex gap-2 justify-end pt-0.5">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={submitting} className="h-6 text-xs">
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!name || submitting} className="h-6 text-xs">
          {submitting ? 'Saving…' : initial.name ? 'Save' : 'Create'}
        </Button>
      </div>
    </form>
  );
}
