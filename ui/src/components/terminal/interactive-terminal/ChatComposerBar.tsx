import {
  AgenticProcess,
  isBusy,
  TypeId,
} from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { ProcessStatusIndicator, getStatusLabel } from '@src/components/agentic-progress/shared/status-indicator';
import { CompactExecutionInput } from '@src/components/entity-execution-panel/CompactExecutionInput';
import { cn } from '@src/lib/utils';
import { notify } from '@src/notifications/notify';
import { ScrollText } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useChatPlanMode } from './chat-plan-mode-context';
import { ChatToolsMenu } from './ChatToolsMenu';
import { COMPOSER_PILL_CLASS } from './composer-pill';

interface ChatComposerBarProps {
  /** The interactive tab's live PTY AgenticProcess. */
  process: AgenticProcess;
  /**
   * Handle images pasted into the composer — upload to the process input dir
   * and open the Files side tab, returning a reference line per image. Supplied
   * by InteractiveTerminal so chat paste reuses the exact PTY paste behaviour.
   */
  onPasteImages?: (files: File[]) => Promise<string[] | void> | string[] | void;
}

/**
 * The chat composer for an interactive agent tab, lifted out of SimpleChatPane so
 * it can live inside the shared TerminalBottomRibbon (one unified bottom ribbon
 * instead of two stacked rows). Sends through the standard `prompt()` (routed to
 * the PTY for a visible process) and interrupts the in-flight turn via
 * `interruptTurn()`. Status + busy come from the gold entity, reflected live.
 */
export function ChatComposerBar({ process, onPasteImages }: ChatComposerBarProps) {
  const { t } = useLingui();
  const [sending, setSending] = useState(false);
  const plan = useChatPlanMode();

  const handleSend = useCallback(
    async (text: string) => {
      if (sending) return;
      setSending(true);
      try {
        // Plan toggle on → send this turn read-only (`--permission-mode plan`).
        await process.prompt(text, undefined, plan.planPending ? { permissionMode: 'plan' } : undefined);
      } catch (err) {
        console.error('[ChatComposerBar] prompt failed', err);
        notify.error({ title: t`Message not sent`, message: err instanceof Error ? err.message : String(err) });
      } finally {
        setSending(false);
      }
    },
    [process, sending, plan.planPending, t],
  );

  const handleStop = useCallback(async () => {
    try {
      await process.interruptTurn();
    } catch (err) {
      console.error('[ChatComposerBar] interrupt failed', err);
      notify.error({ title: t`Could not stop`, message: err instanceof Error ? err.message : String(err) });
    }
  }, [process, t]);

  // Reflect the gold entity reactively — the prop comes from the loader context
  // and may not re-render on data_op patches (worker_status flips on transcript
  // transitions). Same pattern as EntityExecutionPanel / SimpleChatPane.
  const processTypeId = useMemo(() => new TypeId(AgenticProcess.type, process.id), [process.id]);
  const { data: liveProcess } = useEntity<AgenticProcess>(processTypeId, { watch: true });
  const reflected = liveProcess ?? process;

  // Headless and PTY turns both broadcast status live now, so the reactive
  // entity is the single source. One boolean gates the composer: the backend's
  // turn-in-flight `busy` boolean (serialized alongside `status`; read via
  // `isBusy`). A dead PTY reads ¬busy and is relaunched by prompt(), so it stays
  // sendable.
  const indicatorProcess = reflected;
  const busy = isBusy(indicatorProcess);

  return (
    <CompactExecutionInput
      bare
      onSend={handleSend}
      disabled={sending || busy}
      running={busy}
      onStop={handleStop}
      onPasteImages={onPasteImages}
      placeholder={plan.planPending ? t`Plan mode — describe what to plan…` : t`Message the agent…`}
      onShiftTab={plan.enabled ? plan.togglePlan : undefined}
      leadingSlot={
        <div className="flex items-center gap-2">
          <ChatToolsMenu />
          {plan.enabled ? (
            <button
              type="button"
              onClick={plan.togglePlan}
              title={t`Toggle plan mode (Shift+Tab)`}
              data-testid="plan-mode-pill"
              aria-pressed={plan.planPending}
              className={cn(
                COMPOSER_PILL_CLASS,
                plan.planPending
                  ? 'border-blue-400 bg-blue-400/15 text-blue-300'
                  : 'border-border/60 text-muted-foreground hover:border-blue-400/50 hover:text-foreground',
              )}
            >
              <ScrollText className="h-3.5 w-3.5" />
              <Trans>Plan</Trans>
            </button>
          ) : null}
        </div>
      }
      statusSlot={
        <span
          title={getStatusLabel(indicatorProcess)}
          className="flex items-center"
          data-testid="simple-chat-status"
        >
          <ProcessStatusIndicator process={indicatorProcess} showLabel size="sm" className="px-1 text-muted-foreground" />
        </span>
      }
    />
  );
}
