/**
 * What kind of automation this is — schedule, event, file or agent — as an icon
 * and a short word. One mapping, used by the gallery, the list and the runs.
 */
import type { AutomationKind } from '@sdk';
import { Bot, CalendarClock, FileText, Radio, type LucideIcon } from 'lucide-react';
import { cn } from '@src/lib/utils';
import { useAutomationWords } from './automation-words';

export const KIND_ICON: Record<AutomationKind, LucideIcon> = {
  schedule: CalendarClock,
  event: Radio,
  file: FileText,
  agent_hook: Bot,
};

export function KindBadge({
  kind,
  className,
  iconOnly,
}: {
  kind: AutomationKind;
  className?: string;
  iconOnly?: boolean;
}) {
  const words = useAutomationWords();
  const Icon = KIND_ICON[kind];
  return (
    <span
      className={cn('inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground', className)}
      title={words.kind(kind)}
      data-kind={kind}
    >
      <Icon className="size-3.5" aria-hidden />
      {!iconOnly && words.kindShort(kind)}
    </span>
  );
}
