import { TypeId } from '@sdk';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { editorForType } from '@src/navigation/asset-doc-types';
import { useDockNavigation } from '@src/navigation';
import { useCallback } from 'react';
import type { ChipTarget } from './toolEventDescriptor';

/**
 * Turn a chip's {@link ChipTarget} into a click handler, or null when the chip
 * has nothing to open (the row stays a plain payload expander).
 *
 * Every destination goes through `navigation.*` — the click handler navigates
 * and nothing else; the loader is still the single writer of context.
 */
export function useChipTarget(target: ChipTarget): (() => void) | null {
  const { navigation } = useDockNavigation();

  const open = useCallback(() => {
    switch (target.kind) {
      case 'file':
        navigation.openFile(target.path, target.line ? { line: target.line } : undefined);
        return;
      case 'entity': {
        // `flow show entity <typeid>` addresses an entity the same way the
        // display-target flow does — reuse that mapping rather than inventing
        // a second one.
        const typeId = new TypeId(target.typeId);
        const editor = editorForType(typeId.type);
        if (!editor) return;
        navigation.openDock(AssetDocPointer.forTypeId(editor, typeId).toDockPointer());
        return;
      }
      default:
        return;
    }
  }, [navigation, target]);

  return target.kind === 'none' ? null : open;
}
