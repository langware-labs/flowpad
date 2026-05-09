import { useMemo, useState } from 'react';
import { History } from 'lucide-react';
import type { TypeId } from '@sdk';
import { TabbedSideDrawer } from '@src/components/ui/side-drawer';
import { useRunsForTarget } from './useRunsForTarget';
import { RunsListPanel } from './RunsListPanel';

type RunsTabId = 'runs';

interface RunsDrawerProps {
  /** Anchor entity for the run history. Every Run created by `run-headless`
   *  carries `target_vfs_path` matching this typeid. */
  targetTypeId: TypeId;
  className?: string;
  testId?: string;
}

/**
 * Right-side drawer listing every Approve & Execute (Run) for the anchor
 * entity. One row per Run; multiple Runs for the same target share the
 * underlying AgenticProcess (Claude session continuity), so the terminal
 * icon on any row attaches to the same shared session.
 */
export function RunsDrawer({ targetTypeId, className, testId }: RunsDrawerProps) {
  const targetKey = useMemo(() => targetTypeId.toString(), [targetTypeId]);
  const { runs } = useRunsForTarget(targetKey);

  const [open, setOpen] = useState(true);
  const tabs = useMemo(
    () => [{ id: 'runs' as RunsTabId, label: `Runs ${runs.length}`, icon: History }],
    [runs.length],
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
        runs: <RunsListPanel runs={runs} />,
      }}
    </TabbedSideDrawer>
  );
}
