/**
 * A schedule's time zone, without an "Advanced" section: a chip beside the time that shows only
 * when the zone is not this computer's, and one searchable list — "This computer" first — to pick
 * from. The "Once" date field holds the same list under its calendar.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { Calendar as CalendarIcon, Globe } from 'lucide-react';
import { forwardRef, useMemo, useState, type ButtonHTMLAttributes } from 'react';
import { Calendar } from '@src/components/ui/calendar';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@src/components/ui/command';
import { Input } from '@src/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { cn } from '@src/lib/utils';
import { knownZones, localZone, onceParts, zoneLabel, zoneOffset } from '../time-zone';

/** `value` is the stored zone; empty means this computer's. */
interface ZoneProps {
  value: string;
  onChange: (zone: string) => void;
  disabled?: boolean;
}

const differs = (value: string) => !!value && value !== localZone();

export function TimeZoneList({ value, onChange, disabled }: ZoneProps) {
  const { t } = useLingui();
  const here = localZone();
  const chosen = value === here ? '' : value;
  // The stored zone is offered even when this browser does not list it.
  const zones = useMemo(
    () => [...new Set([...knownZones(), ...(chosen ? [chosen] : [])])].filter((zone) => zone !== here),
    [here, chosen],
  );
  const row = (zone: string, label: string) => (
    <CommandItem
      key={zone}
      value={`${label} ${zone}`}
      disabled={disabled}
      onSelect={() => onChange(zone)}
      data-testid={`timezone-option-${zone || 'local'}`}
      className={cn('flex justify-between gap-3 text-xs', zone === chosen && 'bg-accent')}
    >
      <span className="min-w-0 truncate">{label}</span>
      <span className="shrink-0 text-muted-foreground">{zoneOffset(zone || here)}</span>
    </CommandItem>
  );
  return (
    <Command data-testid="when-schedule-timezone">
      <CommandInput placeholder={t`Time zone — type a city`} className="h-8 text-xs" />
      <CommandList className="max-h-36">
        <CommandEmpty className="px-3 py-2 text-xs text-muted-foreground">
          <Trans>No such time zone.</Trans>
        </CommandEmpty>
        {row('', t`This computer · ${here}`)}
        {zones.map((zone) => row(zone, zone.replace(/_/g, ' ')))}
      </CommandList>
    </Command>
  );
}

const CHIP = 'inline-flex h-7 items-center gap-1 rounded-full bg-muted px-2 text-xs';

/** The zone, said beside the time — only ever rendered for a zone that is not this computer's. */
const ZoneChip = forwardRef<HTMLButtonElement, { value: string } & ButtonHTMLAttributes<HTMLButtonElement>>(
  function ZoneChip({ value, ...button }, ref) {
    const { t } = useLingui();
    const here = localZone();
    return (
      <button
        ref={ref}
        type="button"
        title={t`${value} — not this computer's time zone (${here})`}
        data-testid="when-schedule-timezone-chip"
        className={CHIP}
        {...button}
      >
        {zoneLabel(value)}
      </button>
    );
  },
);

/** Beside a time field: the chip when the zone differs, else a quiet button; both open the list. */
export function TimeZoneControl({ value, onChange, disabled }: ZoneProps) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {differs(value) ? (
          <ZoneChip value={value} disabled={disabled} />
        ) : (
          <button
            type="button"
            disabled={disabled}
            title={t`Time zone: this computer's`}
            aria-label={t`Time zone`}
            data-testid="when-schedule-timezone-open"
            className="inline-flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Globe className="size-3.5" aria-hidden />
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <TimeZoneList
          value={value}
          disabled={disabled}
          onChange={(zone) => {
            onChange(zone);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "Once": a day, a time and the zone in one calendar panel. `value` is `YYYY-MM-DDTHH:mm`. */
export function DateTimeField({
  value,
  onChange,
  zone,
  onZoneChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  zone: string;
  onZoneChange: (zone: string) => void;
  disabled?: boolean;
}) {
  const { i18n } = useLingui();
  const [open, setOpen] = useState(false);
  const { day, date: selected, label, time: set } = onceParts(value, i18n.locale);
  const time = set || '09:00';
  const shown = selected ? `${label}, ${time}` : '';
  return (
    <span className="flex items-center gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            data-testid="when-schedule-once"
            className="flex h-9 w-60 items-center justify-between rounded-md border border-input bg-transparent px-3 text-sm shadow-sm disabled:opacity-50"
          >
            <span className="tabular-nums">{shown}</span>
            <CalendarIcon className="size-4 text-muted-foreground" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-0" data-testid="when-schedule-once-panel">
          <div className="flex flex-col items-center gap-1.5 px-3 pb-2 pt-1">
            <Calendar
              mode="single"
              selected={selected}
              defaultMonth={selected}
              onSelect={(d) => d && onChange(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${time}`)}
            />
            <Input
              type="time"
              value={time}
              onChange={(e) => day && onChange(`${day}T${e.target.value}`)}
              className="w-32"
              data-testid="when-schedule-once-time"
            />
          </div>
          <div className="border-t border-border">
            <TimeZoneList value={zone} onChange={onZoneChange} />
          </div>
        </PopoverContent>
      </Popover>
      {differs(zone) && <ZoneChip value={zone} disabled={disabled} onClick={() => setOpen(true)} />}
    </span>
  );
}
