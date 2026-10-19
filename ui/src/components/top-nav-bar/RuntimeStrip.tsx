import { useContext } from '@src/hooks/useContext';
import { cn } from '@src/lib/utils';
import { RuntimeIcon, RuntimeLabel } from './RuntimeChip';
import { RUNTIME_CLASS } from './runtime-appearance';

/**
 * The runtime's color, glyph and word as a band — for a surface that has no nav bar to carry
 * the `RuntimeChip` (an entry page) or that covers it (a modal). Same table, same words: it
 * answers "whose machine am I on" and nothing else.
 */
export function RuntimeStrip({ className }: { className?: string }) {
  const { runtimeKind } = useContext();
  return (
    <div
      className={cn('flex items-center gap-2 px-4 py-2 text-xs font-semibold', RUNTIME_CLASS[runtimeKind], className)}
      data-runtime={runtimeKind}
      data-testid="runtime-strip"
    >
      <RuntimeIcon kind={runtimeKind} className="h-4 w-4" />
      <RuntimeLabel kind={runtimeKind} />
    </div>
  );
}
