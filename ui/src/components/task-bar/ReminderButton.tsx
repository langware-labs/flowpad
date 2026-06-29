/**
 * ReminderButton - Popover with quick picks and custom slider for setting reminders.
 */

import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Separator } from '@src/components/ui/separator';
import { ToggleGroup, ToggleGroupItem } from '@src/components/ui/toggle-group';
import { Slider } from '@src/components/ui/slider';
import { Bell } from 'lucide-react';
import { useState } from 'react';
import type { Task } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';

interface ReminderButtonProps {
  task: Task;
  onSetReminder: (task: Task, date: Date) => void;
}

export function ReminderButton({ task, onSetReminder }: ReminderButtonProps) {
  const { t } = useLingui();
  const [count, setCount] = useState(1);
  const [unit, setUnit] = useState<'days' | 'weeks'>('days');
  const [open, setOpen] = useState(false);

  const computeDate = (amount: number, u: 'days' | 'weeks') => {
    const d = new Date();
    d.setDate(d.getDate() + amount * (u === 'weeks' ? 7 : 1));
    return d;
  };

  const handleQuickPick = (amount: number, u: 'days' | 'weeks') => {
    onSetReminder(task, computeDate(amount, u));
    setOpen(false);
  };

  const handleSliderCommit = (value: number[]) => {
    setCount(value[0]);
    onSetReminder(task, computeDate(value[0], unit));
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="task-card-action" title={t`Set reminder`} onClick={(e) => e.stopPropagation()}>
          <Bell className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="left" className="w-56 p-2" onClick={(e) => e.stopPropagation()}>
        {/* Quick picks */}
        <div className="flex gap-1.5 pb-2">
          <button
            onClick={() => handleQuickPick(1, 'days')}
            className="rounded-md bg-muted px-2 py-1 text-xs hover:bg-accent"
          >
            <Trans>Tomorrow</Trans>
          </button>
          <button
            onClick={() => handleQuickPick(1, 'weeks')}
            className="rounded-md bg-muted px-2 py-1 text-xs hover:bg-accent"
          >
            <Trans>Next week</Trans>
          </button>
        </div>
        <Separator />
        {/* Custom picker */}
        <div className="flex items-center gap-2 pt-2">
          <Slider
            min={1}
            max={30}
            step={1}
            value={[count]}
            onValueChange={(v) => setCount(v[0])}
            onValueCommit={handleSliderCommit}
            className="flex-1"
          />
          <ToggleGroup
            type="single"
            value={unit}
            onValueChange={(v) => {
              if (v) setUnit(v as 'days' | 'weeks');
            }}
            className="shrink-0"
          >
            <ToggleGroupItem value="days" className="h-6 px-1.5 text-[10px]">
              <Trans>d</Trans>
            </ToggleGroupItem>
            <ToggleGroupItem value="weeks" className="h-6 px-1.5 text-[10px]">
              <Trans>w</Trans>
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        <span className="mt-1 block text-[10px] text-muted-foreground">
          <Trans>Remind in {count} {unit === 'days' ? (count === 1 ? 'day' : 'days') : count === 1 ? 'week' : 'weeks'}</Trans>
        </span>
      </PopoverContent>
    </Popover>
  );
}
