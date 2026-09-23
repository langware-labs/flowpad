import { useMemo } from 'react';
import { Trans } from '@lingui/react/macro';
import { DataSource, editorForType, Trigger, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { DataSourceDetail } from '@src/components/data-sources/DataSourceDetail';
import { ScheduleTriggerEditor } from '@src/components/triggers-view/ScheduleTriggerEditor';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import type { ChildSection } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { AssetEditorRouter } from '../AssetEditorRouter';
import { NestedHostContext, type NestedHost } from '../nested-host';

function Missing() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground" data-testid="agent-child-missing">
      <Trans>This item no longer exists.</Trans>
    </div>
  );
}

function SourceChild({ typeId, onGone }: { typeId: TypeId; onGone: () => void }) {
  const { data: source, isLoading } = useEntity<DataSource>(typeId);
  if (isLoading) return null;
  return source ? <DataSourceDetail source={source} onDeleted={onGone} /> : <Missing />;
}

function ScheduleChild({ typeId, onDone }: { typeId: TypeId; onDone: () => void }) {
  const { data: trigger, isLoading } = useEntity<Trigger>(typeId);
  if (isLoading) return null;
  if (!trigger) return <Missing />;
  return (
    <div className="h-full overflow-y-auto p-6">
      <ScheduleTriggerEditor trigger={trigger} onSaved={() => undefined} onCancel={onDone} />
    </div>
  );
}

/**
 * A view nested in the agent editor, in place of its body (see `DockPointer.child`): the same
 * component the item has anywhere else — an asset's own editor, a source's row, a schedule's
 * editor — in the agent's tab, with the agent's resources still on the left. Closing it (a
 * delete, Cancel) returns to the agent, never to some other screen.
 */
export function AgentChildView({ section, typeIdString }: { section: ChildSection; typeIdString: string }) {
  const { navigation, currentDock } = useDockNavigation();
  const typeId = useMemo(() => {
    try {
      return new TypeId(typeIdString);
    } catch {
      return null;
    }
  }, [typeIdString]);
  const host = useMemo<NestedHost>(
    () => ({ close: () => currentDock && navigation.openDock(currentDock.withoutChild()) }),
    [currentDock, navigation],
  );

  if (!typeId) return <Missing />;

  let body;
  if (section === 'channel' || section === 'data_source') {
    body = <SourceChild typeId={typeId} onGone={host.close} />;
  } else if (section === 'schedule') {
    body = <ScheduleChild typeId={typeId} onDone={host.close} />;
  } else {
    const editor = editorForType(typeId.type);
    body = editor ? (
      <AssetEditorRouter key={typeIdString} pointer={AssetDocPointer.forTypeId(editor, typeId).toPointer()} />
    ) : (
      <Missing />
    );
  }

  return (
    <NestedHostContext.Provider value={host}>
      <div className="h-full min-h-0" data-testid={`agent-child-${section}`}>
        {body}
      </div>
    </NestedHostContext.Provider>
  );
}
