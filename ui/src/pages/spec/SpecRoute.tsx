import { useMemo } from 'react';
import { ArrowLeft, FileCheck2 } from 'lucide-react';
import { Spec, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';

/**
 * Top-level renderer for the `/dock/spec/<id>` route.
 *
 * Loads the Spec record by id from the dock pointer and shows its title +
 * spec_type + body. Plan id is exposed as a "View source plan" link when set.
 *
 * Self-contained pointer resolution (matches ConversationRoute / TasksViewer
 * convention) — Radix Tabs keeps hidden tabs mounted so we must guard against
 * inheriting a foreign pointer.
 */
export function SpecRoute() {
  const { navigation, currentDock } = useDockNavigation();

  const specId = useMemo(() => {
    if (currentDock?.viewType !== ViewType.SPEC) return null;
    const pointer = currentDock?.pointer;
    if (!pointer) return null;
    const head = pointer.split('/')[0];
    return head || null;
  }, [currentDock?.viewType, currentDock?.pointer]);

  const { data: spec } = useEntity<Spec>(specId ? new TypeId(Spec.type, specId) : null);

  const goBack = () => navigation.openDock(DockPointer.forInbox());

  if (!specId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No spec specified.
      </div>
    );
  }

  if (!spec) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading spec…
      </div>
    );
  }

  const title = spec.title?.trim() || 'Untitled spec';
  const specType = spec.spec_type ?? 'plan';

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <button
          type="button"
          onClick={goBack}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Back to inbox"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <FileCheck2 className="h-4 w-4 text-amber-500" />
        <span className="truncate text-sm font-semibold">{title}</span>
        <span className="ml-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-300">
          {specType}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {spec.content ? (
          <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground/90">
            {spec.content}
          </pre>
        ) : (
          <p className="text-xs italic text-muted-foreground/60">
            This spec has no content.
          </p>
        )}
      </div>
    </div>
  );
}
