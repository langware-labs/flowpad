import { contentAssetTargetForDock, type ContentAssetTarget } from '@src/navigation/content-asset-dock';
import type { DockPointer } from '@src/navigation/DockPointer';
import type { TypeId } from '@sdk';
import { useCallback, useLayoutEffect, useState } from 'react';

export interface AssetWorkContext {
  key: string;
  label: string;
  text: string;
  typeId?: string;
  path?: string;
}

/** Adapt the navigation-layer asset target into chat grounding copy. */
export function assetWorkContextForDock(
  dock: DockPointer,
  resolvedTypeId?: TypeId | string | null,
  resolvedLabel?: string | null,
): AssetWorkContext | null {
  const target = contentAssetTargetForDock(dock, resolvedTypeId);
  return target
    ? assetWorkContextForTarget({
        ...target,
        label: resolvedLabel?.trim() || target.label,
      })
    : null;
}

function assetWorkContextForTarget(target: ContentAssetTarget): AssetWorkContext {
  const exactTarget = [
    target.typeId ? `TypeId: ${target.typeId}` : null,
    target.path ? `path: ${target.path}` : null,
  ].filter(Boolean).join(', ');

  return {
    key: target.targetVfsPath,
    label: target.label,
    typeId: target.typeId,
    path: target.path,
    text:
      `The active asset is ${target.label} (${exactTarget || target.targetVfsPath}). ` +
      'Discuss this asset in the context of the user request. If the user asks for a change, edit or refactor the original asset.',
  };
}

/**
 * One-shot context keyed by the active asset.
 *
 * Consumption compares the captured key, so completion of an old in-flight
 * prompt cannot clear the context for a child selected in the meantime.
 */
export function useKeyedAssetPromptContext(context: AssetWorkContext | null): {
  promptContext: AssetWorkContext | null;
  consume: (key: string) => void;
} {
  const [pendingKey, setPendingKey] = useState<string | null>(context?.key ?? null);

  useLayoutEffect(() => {
    setPendingKey(context?.key ?? null);
  }, [context?.key]);

  const consume = useCallback((key: string) => {
    setPendingKey((current) => (current === key ? null : current));
  }, []);

  return {
    promptContext: context && pendingKey === context.key ? context : null,
    consume,
  };
}
