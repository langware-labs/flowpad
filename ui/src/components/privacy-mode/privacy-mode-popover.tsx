import { useCallback, useState } from 'react';
import { Cloud, ExternalLink, ShieldCheck } from 'lucide-react';
import { privacyManager, type PrivacyMode } from '@sdk';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Switch } from '@src/components/ui/switch';
import { usePrivacyMode } from '@src/hooks/use-privacy-mode';
import { notify } from '@src/notifications/notify';

const LEARN_MORE_URL = 'https://flowpad.ai/your-data';

const MODE_META: Record<
  PrivacyMode,
  { name: string; icon: React.ComponentType<{ className?: string }>; explanation: string; tint: string }
> = {
  local: {
    name: 'Local',
    icon: ShieldCheck,
    explanation:
      'No data leaves this machine. Sharing and login are disabled. Auto-update stays active.',
    tint: 'text-emerald-500',
  },
  connected: {
    name: 'Connected',
    icon: Cloud,
    explanation:
      'When data is shared on a conversation, it is sent to all members using Flowpad cloud.',
    tint: 'text-blue-500',
  },
};

/**
 * Footer data-privacy control — replaces the old settings gear. Shows the
 * current mode (icon + name), its explanation, a switch to flip Local ⇄
 * Connected, and a learn-more link. The active mode reads from privacyManager
 * (the SSoT) via usePrivacyMode, so it updates live on toggle + WS broadcast.
 */
export function PrivacyModePopover() {
  const { mode, isLocal } = usePrivacyMode();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const meta = MODE_META[mode];
  const Icon = meta.icon;

  const handleToggle = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await privacyManager.toggle();
    } catch (e: any) {
      notify.error({
        title: 'Could not change privacy mode',
        message: e?.response?.data?.message ?? e?.message ?? String(e),
      });
    } finally {
      setBusy(false);
    }
  }, [busy]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={`flex h-6 w-6 items-center justify-center rounded-sm transition-colors hover:bg-accent ${meta.tint}`}
          title={`Data privacy: ${meta.name}`}
          aria-label={`Data privacy mode: ${meta.name}`}
          data-testid="privacy-mode-trigger"
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 p-3">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <div className={`rounded-md bg-muted p-1.5 ${meta.tint}`}>
              <Icon className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{meta.name}</p>
              <p className="text-[11px] text-muted-foreground">Data privacy mode</p>
            </div>
            <Switch
              checked={!isLocal}
              onCheckedChange={() => void handleToggle()}
              disabled={busy}
              aria-label="Toggle Connected mode"
              data-testid="privacy-mode-switch"
            />
          </div>

          <p className="text-xs text-muted-foreground">{meta.explanation}</p>

          <a
            href={LEARN_MORE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline"
          >
            Learn about your data
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default PrivacyModePopover;
