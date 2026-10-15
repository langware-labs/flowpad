import { useLingui } from '@lingui/react/macro';
import { Loader2, Zap } from 'lucide-react';
import type { AgenticProcess } from '@sdk';
import {
  automationLineage,
  automationState,
  latestSession,
  returnedValue,
  useMessageAutomationSessions,
} from '@src/hooks/conversation/useMessageAutomationSessions';
import { cn } from '@src/lib/utils';
import { LOCAL_COMPUTE_NODE } from '@src/navigation/asset-doc-types';
import { DockPointer } from '@src/navigation/DockPointer';
import type { NavigationActions } from '@src/navigation/NavigationActions';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

/** A session's returned value as a chip: its label, and the open that shows it in its kind's viewer. */
export function openableValue(
  session: AgenticProcess,
  navigation: Pick<NavigationActions, 'openMachinePath'>,
): { label: string; onOpen: () => void } | null {
  const value = returnedValue(session);
  return value && { label: value.label, onOpen: () => navigation.openMachinePath(value.path, LOCAL_COMPUTE_NODE) };
}

/**
 * The conversation's automation, in its header: what the newest run is doing, then **Open** what it
 * returned (in its kind's viewer) or **Open error** (its session). Absent when no automation ran here.
 * Clicks only navigate.
 */
export function ConversationAutomationChip({ conversationId }: { conversationId: string }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const session = latestSession(useMessageAutomationSessions(conversationId));
  if (!session) return null;

  const state = automationState(session);
  const value = state === 'done' ? openableValue(session, navigation) : null;
  const name = session.name || automationLineage(session)?.name || t`Automation`;
  const label = {
    working: t`working…`,
    failed: t`couldn't finish · Open error`,
    done: value ? t`ready · Open` : t`done`,
  }[state];

  return (
    <button
      type="button"
      onClick={value?.onOpen ?? (() => navigation.openDock(DockPointer.forProcessRuns({ run: session.id })))}
      className={cn(
        'inline-flex max-w-[22rem] items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs',
        state === 'failed' ? 'border-red-500/50 bg-red-500/10 text-foreground' : 'border-border text-foreground hover:bg-accent',
      )}
      title={value ? t`Open what it returned` : t`Open the session`}
      data-testid="conversation-automation-chip"
      data-status={state}
    >
      {state === 'working' ? <Loader2 className="size-3 shrink-0 animate-spin" /> : <Zap className="size-3 shrink-0" />}
      <span className="truncate">{name}</span>
      <span className="shrink-0 text-muted-foreground">{label}</span>
    </button>
  );
}
