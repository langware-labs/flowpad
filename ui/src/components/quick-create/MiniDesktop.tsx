import { favoritesFilterForScope } from '@src/lib/bookmark-scope';
import type { ScopeFilter } from '@src/lib/scope-filter';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ViewType } from '@src/types/ViewType';
import { Maximize2 } from 'lucide-react';
import { useMemo } from 'react';
import { useLingui } from '@lingui/react/macro';
import { DesktopSurface } from './DesktopSurface';

/**
 * MiniDesktop — the compact desktop strip on the home landing (unscoped) and the
 * project home (scoped via `scope`). When scoped, the grid shows only that
 * scope's favorites and the corner expand affordance opens the full-page desktop
 * pinned to the same scope (`/dock/desktop?<scope>` → a "<project> Desktop" tab);
 * unscoped it opens the global desktop. URL-first, same surface with more slots.
 */
export function MiniDesktop({ scope }: { scope?: ScopeFilter }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();

  const filter = useMemo(() => favoritesFilterForScope(scope), [scope]);

  const openFullDesktop = () => {
    const base = new DockPointer(ViewType.DESKTOP);
    navigation.openDock(scope ? base.withScopeFilter(scope) : base);
  };

  return (
    <div className="relative rounded-lg border border-border bg-card/50 px-4 py-3">
      <DesktopSurface className="pr-6" filter={filter} />

      <button
        type="button"
        onClick={openFullDesktop}
        aria-label={t`Open full desktop`}
        title={t`Open full desktop`}
        className="absolute right-1.5 top-1.5 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Maximize2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
