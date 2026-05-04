import { useMemo, useState } from 'react';
import { History } from 'lucide-react';
import type { TypeId } from '@sdk';
import { TabbedSideDrawer } from '@src/components/ui/side-drawer';
import { useProcessesForTarget } from '@src/components/entity-chat-panel/hooks/useProcessesForTarget';
import { WorkflowRunsPanel } from '@src/components/workflows-view/WorkflowRunsPanel';
import { buildRunEntries } from '@src/components/task-bar/task-runs';

type RunsTabId = 'runs';

interface RunsDrawerProps {
  /** Anchor entity for the run history. The `target_vfs_path` of every
   *  AgenticProcess spawned by `run-headless` matches this typeid. */
  targetTypeId: TypeId;
  computeNodeId?: string;
  className?: string;
  testId?: string;
}

/**
 * Right-side drawer hosting the headless run history for any anchor entity
 * (Task, Conversation, etc).
 *
 * Generic over the entity that anchors the runs: every headless run spawned
 * via `<entity>/<id>/run-headless` carries `target_vfs_path = entity TypeId`,
 * and `useProcessesForTarget` queries by that key — so the drawer is the
 * same component regardless of whether the host is a Task or a Conversation.
 *
 * Task scope was the first user (see `SharedTaskView`); the conversation
 * scope (`ConversationRoute` for hub-direct conversations from homelanding)
 * is the second.
 */
export function RunsDrawer({ targetTypeId, computeNodeId, className, testId }: RunsDrawerProps) {
  const targetKey = useMemo(() => targetTypeId.toString(), [targetTypeId]);
  const { processes } = useProcessesForTarget(targetKey);
  const entries = useMemo(() => buildRunEntries(processes), [processes]);

  const [open, setOpen] = useState(true);
  const tabs = useMemo(
    () => [{ id: 'runs' as RunsTabId, label: `Runs ${entries.length}`, icon: History }],
    [entries.length],
  );

  return (
    <TabbedSideDrawer<RunsTabId>
      open={open}
      onOpenChange={setOpen}
      tabs={tabs}
      activeTab="runs"
      onActiveTabChange={() => {}}
      width="w-72"
      className={className}
      data-testid={testId ?? 'runs-drawer'}
    >
      {{
        runs: (
          <WorkflowRunsPanel
            entries={entries}
            currentEntry={entries[0] ?? null}
            computeNodeId={computeNodeId}
          />
        ),
      }}
    </TabbedSideDrawer>
  );
}
