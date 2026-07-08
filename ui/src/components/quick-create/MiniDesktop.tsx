import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ViewType } from '@src/types/ViewType';
import { Maximize2 } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { DesktopSurface } from './DesktopSurface';

/**
 * MiniDesktop — the compact desktop strip on the home landing. The corner
 * expand affordance navigates to the full-page desktop (/dock/desktop) —
 * URL-first, same surface with more slots.
 */
export function MiniDesktop() {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();

  return (
    <div className="relative rounded-lg border border-border bg-card/50 px-4 py-3">
      <DesktopSurface className="pr-6" />

      <button
        type="button"
        onClick={() => navigation.openDock(new DockPointer(ViewType.DESKTOP))}
        aria-label={t`Open full desktop`}
        title={t`Open full desktop`}
        className="absolute right-1.5 top-1.5 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Maximize2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
