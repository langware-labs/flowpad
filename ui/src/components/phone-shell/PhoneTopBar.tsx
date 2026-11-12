/**
 * The phone shell (below `md`): one bar — back · title · menu — in place of the desktop's nav bar, rail,
 * tab strip and footer, which the shell hides with CSS (nothing is unmounted). The menu is `PhoneMenu`.
 */
import { useLingui } from '@lingui/react/macro';
import { ArrowLeft, Menu } from 'lucide-react';
import { useEntityBreadcrumbs } from '@src/components/top-nav-bar/use-entity-breadcrumbs';
import { useSidebar } from '@src/components/ui/sidebar';
import { useHistoryNav } from '@src/navigation/use-history-nav';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ViewType } from '@src/types/ViewType';

/** A finger-sized control: 44px, the icon centred. */
const TOUCH = 'flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground active:bg-muted';

/** Opens the phone menu. A view that draws its own phone header (`ViewerMeta.phoneHeader: 'own'`) carries it too. */
export function PhoneMenuButton() {
  const { t } = useLingui();
  const { setOpenMobile } = useSidebar();
  return (
    <button
      type="button"
      className={`${TOUCH} md:hidden`}
      aria-label={t`Menu`}
      data-testid="phone-menu-button"
      onClick={() => setOpenMobile(true)}
    >
      <Menu className="h-5 w-5" />
    </button>
  );
}

/** Draws — and subscribes to — nothing at `md` and up. */
export function PhoneTopBar() {
  return useSidebar().isMobile ? <Bar /> : null;
}

function Bar() {
  const { t } = useLingui();
  const { currentDock, navigation } = useDockNavigation();
  const { canGoBack } = useHistoryNav();
  // The address bar's own answer to "what is this": its current crumb.
  const { crumbs } = useEntityBreadcrumbs(currentDock);
  const title = crumbs.find((crumb) => crumb.kind === 'current')?.label ?? '';
  // A freshly loaded Home has nowhere to go back to: no history, and Home is where the fallback leads.
  const atHome = !currentDock || currentDock.viewType === ViewType.HOME;

  return (
    // `md:hidden` as well as the gate above: the width is known to CSS a frame before it is to JS.
    <div
      data-testid="phone-top-bar"
      className="flex shrink-0 items-center gap-1 border-b bg-background px-1 pt-[var(--sat)] md:hidden"
    >
      {canGoBack || !atHome ? (
        <button
          type="button"
          className={TOUCH}
          aria-label={t`Back`}
          data-testid="phone-back"
          onClick={() => navigation.backOrHome()}
        >
          <ArrowLeft className="h-5 w-5 rtl:-scale-x-100" />
        </button>
      ) : (
        <span className="w-2" />
      )}
      <div className="min-w-0 flex-1 truncate text-base font-medium" data-testid="phone-title">
        {title}
      </div>
      <PhoneMenuButton />
    </div>
  );
}
