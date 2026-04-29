import { Spec, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { X } from 'lucide-react';

interface SpecSidePaneProps {
  open: boolean;
  onClose: () => void;
  specId: string | null | undefined;
}

export function SpecSidePane({ open, onClose, specId }: SpecSidePaneProps) {
  const { data: spec } = useEntity<Spec>(specId ? new TypeId(Spec.type, specId) : null);
  if (!open) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/30"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside className="fixed right-0 top-0 z-50 flex h-screen w-96 flex-col border-l bg-background shadow-xl">
        <div className="flex h-[52px] flex-shrink-0 items-center gap-1 border-b px-3">
          <span className="truncate text-xs font-medium text-muted-foreground">
            {spec?.title || 'Task'}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="flex flex-1 flex-col gap-2 overflow-auto p-3">
          {!specId ? (
            <p className="text-xs italic text-muted-foreground">No spec attached to this task.</p>
          ) : !spec ? (
            <p className="text-xs italic text-muted-foreground">Loading…</p>
          ) : (
            <>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                {spec.spec_type ?? 'spec'}
              </div>
              <pre className="whitespace-pre-wrap break-words text-sm text-foreground/90">
                {spec.content || '(empty)'}
              </pre>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
