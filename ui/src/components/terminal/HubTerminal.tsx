import { ComputeNode, Shell, Tab } from '@sdk';
import { Trans } from '@lingui/react/macro';
import { Button } from '@src/components/ui/button';
import { NODE_PARAM } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import React, { useEffect, useMemo, useState } from 'react';
import { TerminalPanel } from './TerminalPanel';

/**
 * The terminal body on the HUB page. The hub keeps no Tab or Shell rows — a
 * terminal there is a PTY session on a compute node (`terminal-command/*`) — so
 * the URL is the whole identity: the shell id plus `?node=<compute node id>`.
 * The panel is the desk's own `TerminalPanel` fed an in-memory Tab for that URL;
 * the strip above it lists the node's live sessions (`Shell.list`) and opens
 * another one through the same `openNewShell` the machine card uses.
 */
export const HubTerminal: React.FC<{ className?: string }> = ({ className = '' }) => {
  const { currentDock, navigation } = useDockNavigation();
  const pointer = currentDock?.pointer ?? '';
  const nodeId = currentDock?.options?.[NODE_PARAM] ?? null;
  const shellId = pointer.startsWith(`${Shell.type}-`) ? pointer.slice(Shell.type.length + 1) : pointer;

  const tab = useMemo(
    () =>
      currentDock && shellId
        ? new Tab({
            id: shellId,
            pointer: currentDock.toJSON(),
            target_type: Shell.type,
            target_id: shellId,
          })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one panel per shell
    [shellId],
  );

  const [sessions, setSessions] = useState<Shell[]>([]);
  useEffect(() => {
    if (!nodeId) return;
    let stale = false;
    void Shell.list(nodeId)
      .then((list) => {
        if (!stale) setSessions(list);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [nodeId, shellId]);

  // The list is read as this shell mounts — before its own start lands — so the
  // shell being shown joins the strip from the client cache.
  const current = Shell.getByIdFromCache<Shell>(shellId);
  const strip = current && !sessions.some((s) => s.id === shellId) ? [...sessions, current] : sessions;

  const openSession = (id: string) => void navigation.openShell(id);
  const openAnother = async () => {
    if (!nodeId) return;
    const node = ComputeNode.getByIdFromCache<ComputeNode>(nodeId) ?? (await ComputeNode.getById<ComputeNode>(nodeId));
    if (node) await navigation.openNewShell({ computeNode: node });
  };

  return (
    <div className={`flex h-full flex-col ${className}`} data-testid="hub-terminal">
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b px-2 py-1">
        {strip.map((s) => (
          <Button
            key={s.id}
            size="sm"
            variant={s.id === shellId ? 'secondary' : 'ghost'}
            className="h-7 shrink-0 px-2.5 text-xs"
            data-testid="hub-terminal-session"
            data-session-id={s.id}
            onClick={() => openSession(s.id)}
          >
            {s.name || s.id.slice(0, 8)}
          </Button>
        ))}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 shrink-0 px-2.5 text-xs"
          data-testid="hub-terminal-new"
          disabled={!nodeId}
          onClick={() => void openAnother()}
        >
          <Trans>+ Terminal</Trans>
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">{tab && <TerminalPanel key={tab.id} tab={tab} isActive />}</div>
    </div>
  );
};
