import { useCallback, useEffect, useState } from 'react';
import { AgenticProcess, type AssetDescriptor, type TypeId } from '@sdk';
import { Boxes } from 'lucide-react';
import { AssetManagerPopover } from './AssetManagerPopover';

const EMPTY_REFS: string[] = [];

function arraysShallowEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

interface AssetManagerButtonProps {
  /** The process whose assets are managed. Null before first-send. */
  process: AgenticProcess | null;
  /** Pre-attached refs (typeid strings); used while process is null for staging. */
  pendingRefs?: string[];
  /** Called after the popover attaches a ref. Caller persists the change. */
  onAttach?: (ref: string) => Promise<void> | void;
  /** Called after detach. */
  onDetach?: (ref: string) => Promise<void> | void;
  /** Optional content rendered below the asset list (e.g. project selector). */
  footer?: React.ReactNode;
  /** Optional element used as the trigger; defaults to a small icon button. */
  trigger?: React.ReactNode;
}

/**
 * Reusable "manage assets for this process" button.
 *
 * Drop into any surface where an `AgenticProcess` is in scope to expose the
 * unified asset manager (read via `process.getAssets()`, attach/detach via
 * `process.embeddedAssets.attach/detach`).
 *
 * The chat panel wraps this with a custom footer for the project selector.
 */
export function AssetManagerButton({
  process,
  pendingRefs = EMPTY_REFS,
  onAttach,
  onDetach,
  footer,
  trigger,
}: AssetManagerButtonProps) {
  // Live attached set — read off the process when present, fall back to
  // pendingRefs when staging pre-create.
  const [attachedRefs, setAttachedRefs] = useState<string[]>([]);

  useEffect(() => {
    const next = process
      ? (((process.embedded_asset_refs ?? []) as TypeId[]).map((r) => r.toString()))
      : pendingRefs;
    setAttachedRefs((prev) => (arraysShallowEqual(prev, next) ? prev : next));
  }, [process, process?.embedded_asset_refs, pendingRefs]);

  const handleAttach = useCallback(
    async (ref: string) => {
      if (process) {
        await process.embeddedAssets.attach(ref);
      }
      setAttachedRefs((prev) => (prev.includes(ref) ? prev : [...prev, ref]));
      await onAttach?.(ref);
    },
    [process, onAttach],
  );

  const handleDetach = useCallback(
    async (ref: string) => {
      if (process) {
        await process.embeddedAssets.detach(ref);
      }
      setAttachedRefs((prev) => prev.filter((r) => r !== ref));
      await onDetach?.(ref);
    },
    [process, onDetach],
  );

  const triggerNode =
    trigger ?? (
      <button
        type="button"
        title="Manage assets"
        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        data-testid="asset-manager-button"
      >
        <Boxes className="h-3.5 w-3.5" />
      </button>
    );

  return (
    <AssetManagerPopover
      process={process}
      attachedRefs={attachedRefs}
      onAttach={handleAttach}
      onDetach={handleDetach}
      trigger={triggerNode}
      footer={footer}
    />
  );
}

// Re-exports so callers can pull the descriptor types from one place.
export type { AssetDescriptor };
