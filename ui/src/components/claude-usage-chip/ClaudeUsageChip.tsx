import { useEffect, useState } from 'react';
import { useClaudeUsage } from '@src/hooks/use-claude-usage';
import { useCostOverview } from '@src/hooks/use-cost-overview';
import { getTodayKey } from '@src/components/cost-dashboard/constants';
import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { ClaudeContextViewer } from '@src/components/lens-viewer/ClaudeContextViewer';
import { pctColor } from '@src/lib/pct-color';
import * as DialogPrimitive from '@radix-ui/react-dialog';

export function ClaudeUsageChip() {
  const [open, setOpen] = useState(false);
  const { data: usage } = useClaudeUsage();
  // Defer cost fetch — footer chip is not critical for initial page load
  const { data: costOverview, refetch } = useCostOverview({ autoFetch: false });
  useEffect(() => {
    const timer = setTimeout(() => void refetch(), 5000);
    return () => clearTimeout(timer);
  }, [refetch]);

  // Push a history entry when the dialog opens so the browser back button closes it
  useEffect(() => {
    if (open) {
      window.history.pushState({ claudeContext: true }, '');
      const onPopState = () => setOpen(false);
      window.addEventListener('popstate', onPopState);
      return () => window.removeEventListener('popstate', onPopState);
    } else if (window.history.state?.claudeContext) {
      window.history.back();
    }
  }, [open]);
  const { flow } = useAgentContext();

  const todayKey = getTodayKey();
  const todayCost = costOverview?.by_day?.[todayKey]?.total_cost_usd ?? null;
  const worstPct = usage ? Math.max(usage.five_hour.pct, usage.seven_day.pct) : 0;
  const sessionId = flow?.session_id ?? null;

  const label = [
    `5h ${usage ? `${usage.five_hour.pct}%` : '-'}`,
    `7d ${usage ? `${usage.seven_day.pct}%` : '-'}`,
    ...(todayCost !== null ? [`$${todayCost.toFixed(2)}`] : []),
  ].join(' · ');

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger asChild>
        <button
          className="flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="Open Claude context dashboard"
        >
          <span className={pctColor(worstPct)}>{label}</span>
        </button>
      </DialogPrimitive.Trigger>

      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content className="fixed inset-0 z-50 flex flex-col bg-background focus:outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" aria-describedby={undefined}>
          <DialogPrimitive.Title className="sr-only">Claude Code — Context Window</DialogPrimitive.Title>
          <ClaudeContextViewer sessionId={sessionId} onClose={() => setOpen(false)} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
