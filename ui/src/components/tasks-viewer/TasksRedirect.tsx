import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Task, TypeId, isTypeId } from '@sdk';
import { useEffect } from 'react';

/**
 * Transition shim for the retired `ViewType.TASKS`. Task now opens through the
 * generic asset editor; this redirects any lingering `/dock/tasks/<id>` deep
 * link (bookmarks, emails, notifications) to `editor/task/typeid/task-<id>`.
 */
export function TasksRedirect() {
  const { navigation, currentDock } = useDockNavigation();
  const pointer = currentDock?.pointer;

  useEffect(() => {
    const head = pointer?.split('/')[0];
    const typeId = head
      ? isTypeId(head)
        ? new TypeId(head)
        : new TypeId(Task.type, head)
      : null;
    navigation.openDock(
      typeId ? DockPointer.forAssetEditorByTypeId('task', typeId) : DockPointer.forAssetList('task'),
      { replace: true },
    );
  }, [pointer, navigation]);

  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      Loading…
    </div>
  );
}
