import { useLingui } from '@lingui/react/macro';
import { useMemo } from 'react';
import { AgenticProcess, RemoteWorkerSession, TypeId } from '@sdk';
import { ViewMode } from '@src/contexts/view-mode-context';
import { ChatActivityLine } from '@src/components/entity-execution-panel/ChatActivityLine';
import { useObservedTurn } from '@src/components/entity-execution-panel/hooks/useObservedTurn';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { useEntity } from '@src/hooks/entity-hooks';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

/** The icon that opens the chat a live session's prompts run in — the host's Claude Code. */
export function OpenSessionChatButton({ processId }: { processId: string }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const Icon = iconForType(AgenticProcess.type);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        navigation.openDock(DockPointer.forShell(`${AgenticProcess.type}-${processId}`).withViewMode(ViewMode.Vibe));
      }}
      data-testid="live-session-open-chat"
      title={t`Open the chat this session runs in`}
      aria-label={t`Open the chat this session runs in`}
      className="inline-flex shrink-0 items-center rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
    </button>
  );
}

/**
 * What the host's Claude Code is doing on a live session's running prompt — the
 * chat's own activity line (tool, detail, elapsed). Host only: `host_process_id`
 * is host-local, so a guest's mirror has no process to observe and this renders
 * nothing there. Renders nothing between turns.
 */
export function LiveSessionActivity({ session }: { session: RemoteWorkerSession }) {
  const processId = session.host_process_id;
  const typeId = useMemo(() => (processId ? new TypeId(AgenticProcess.type, processId) : null), [processId]);
  const { data: process } = useEntity<AgenticProcess>(typeId, { watch: true });
  useObservedTurn(process);
  if (!process) return null;
  return <ChatActivityLine process={process} />;
}
