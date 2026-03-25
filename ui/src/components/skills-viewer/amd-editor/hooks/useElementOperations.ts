import { InstructionElementType } from '@sdk';
import { useCallback } from 'react';
import { useAMDEditor } from '../AMDEditorContext';

/**
 * Hook providing element CRUD operations
 */
export function useElementOperations() {
  const { addElement, updateElement, deleteElement, moveElement, selectElement, selectedId } = useAMDEditor();

  const handleAdd = useCallback(
    (type: InstructionElementType, parentId?: string, afterId?: string) => {
      addElement(type, parentId, afterId);
    },
    [addElement],
  );

  const handleUpdate = useCallback(
    (id: string, updates: Partial<{ content: string; attributes: Record<string, string>; title: string | null }>) => {
      updateElement(id, updates);
    },
    [updateElement],
  );

  const handleDelete = useCallback(
    (id: string) => {
      deleteElement(id);
    },
    [deleteElement],
  );

  const handleMove = useCallback(
    (id: string, direction: 'up' | 'down') => {
      moveElement(id, direction);
    },
    [moveElement],
  );

  const handleSelect = useCallback(
    (id: string | null) => {
      selectElement(id);
    },
    [selectElement],
  );

  return {
    selectedId,
    add: handleAdd,
    update: handleUpdate,
    delete: handleDelete,
    move: handleMove,
    select: handleSelect,
  };
}
