/**
 * The phone menu: the existing `Sidebar` sheet, holding what the hidden desktop chrome held — the places
 * (nav bar + rail), the open tabs (tab strip) and the status chips (rail foot + footer).
 */
import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router';
import { useLingui } from '@lingui/react/macro';
import { useRailEntries } from '@src/components/collapsed-sidebar/collapsed-sidebar';
import { FlowpadAssistantButton } from '@src/components/floating-chat';
import { LanguageSelector } from '@src/components/footer/LanguageSelector';
import { PendingActionsChip } from '@src/components/footer/PendingActionsChip';
import { ThemeToggle } from '@src/components/theme-toggle/theme-toggle';
import { useNavBarPlaces } from '@src/components/top-nav-bar/TopNavBar';
import { NavBadge } from '@src/components/ui/nav-badge';
import { Sidebar, useSidebar } from '@src/components/ui/sidebar';
import { WarningsPopover } from '@src/components/warnings-popover';
import { cn } from '@src/lib/utils';
import { UserDropdown } from '@src/pages/flow-page/content-panel/user-dropdown/user-dropdown';
import { useStripTabs } from '@src/tabs/tab-row-item';

const ROW = 'relative flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-start text-sm active:bg-muted';

/** The sheet's body. The sheet mounts it only while open, so the tab reads cost nothing otherwise. */
function PhoneMenuBody() {
  const { t } = useLingui();
  const { setOpenMobile } = useSidebar();
  const places = [...useNavBarPlaces(), ...useRailEntries()];
  const { items: tabItems, activeKey, select } = useStripTabs();
  // Any navigation closes the menu: picking a place IS the answer to it. Not the mount itself.
  const { key } = useLocation();
  const openedAt = useRef(key);
  useEffect(() => {
    if (key !== openedAt.current) setOpenMobile(false);
  }, [key, setOpenMobile]);

  return (
    <div className="flex h-full flex-col pb-[var(--sab)] pt-[var(--sat)]" data-testid="phone-menu">
      <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
        {places.map(({ key, id, title, icon: Icon, active, open, badge }) => (
          <button
            key={key}
            type="button"
            data-rail-item={id}
            className={cn(ROW, active && 'bg-sidebar-accent font-medium')}
            onClick={open}
          >
            <Icon className="h-5 w-5 shrink-0" />
            {title}
            <NavBadge count={badge ?? 0} className="static ms-auto" />
          </button>
        ))}
        {tabItems.length > 0 && (
          <div className="mt-3 border-t px-3 pb-1 pt-3 text-xs font-medium text-muted-foreground">{t`Open tabs`}</div>
        )}
        {tabItems.map((item) => (
          <button
            key={item.key}
            type="button"
            data-testid="phone-menu-tab"
            className={cn(ROW, item.key === activeKey && 'bg-sidebar-accent font-medium')}
            onClick={() => select(item.key)}
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center">{item.icon}</span>
            <span className="min-w-0 truncate">{item.title}</span>
          </button>
        ))}
      </nav>
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-t p-2">
        <UserDropdown />
        <ThemeToggle />
        <FlowpadAssistantButton />
        <WarningsPopover />
        <PendingActionsChip />
        <span className="ms-auto">
          <LanguageSelector />
        </span>
      </div>
    </div>
  );
}

/** The menu sheet. Lives under the shell's `SidebarProvider`; draws nothing at `md` and up. */
export function PhoneMenu() {
  return useSidebar().isMobile ? (
    <Sidebar>
      <PhoneMenuBody />
    </Sidebar>
  ) : null;
}
