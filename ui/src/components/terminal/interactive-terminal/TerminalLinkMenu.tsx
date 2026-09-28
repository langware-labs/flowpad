import type { AgenticProcess, Shell } from '@sdk';
import { t } from '@lingui/core/macro';
import { AppWindow, Copy, ExternalLink, PanelTop, Sparkles } from 'lucide-react';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@src/components/ui/dropdown-menu';
import { fetchBrowserProfiles, type Browser } from '@src/lib/browser-profiles';
import { errorMessage } from '@src/lib/error-message';
import { useDockNavigation } from '@src/navigation';
import { notify } from '@src/notifications/notify';
import type { TerminalLinkHandlers } from './terminal-links';

export interface TerminalLinks {
  /** Pass to `registerTerminalLinks`; stable for the terminal's lifetime. */
  handlers: TerminalLinkHandlers;
  /** Render beside the terminal container; stable, so the terminal never re-renders for the menu. */
  menu: ReactNode;
}

interface LinkMenuHandle {
  open: (link: string, x: number, y: number, host: AgenticProcess | null) => void;
}

/**
 * Click opens a link in Flowpad; right-click offers copy / open in Flowpad / open in browser / open in one
 * browser profile of this machine, and — when the terminal belongs to a process — Vibe: that process in vibe
 * mode with the link as a tab.
 */
export function useTerminalLinks(source: RefObject<Shell | null>, process?: AgenticProcess | null): TerminalLinks {
  const { navigation } = useDockNavigation();
  // Read the current navigation/source/process without retaining a terminal render's closure.
  const navRef = useRef(navigation);
  navRef.current = navigation;
  const processRef = useRef(process ?? null);
  processRef.current = process ?? null;
  const menuRef = useRef<LinkMenuHandle>(null);

  return useMemo(() => {
    const open = (link: string) => void navRef.current.openLink(link, source.current);
    const openInBrowser = (link: string) => void navRef.current.openLinkInBrowser(link, source.current);
    const openInVibe = (link: string, host: AgenticProcess) =>
      void navRef.current.openLinkInVibe(link, source.current, host);
    const openInProfile = (link: string, browser: string, profile: string) =>
      void navRef.current.openLinkInBrowserProfile(link, source.current, browser, profile);
    return {
      handlers: {
        activate: (_event, link) => open(link),
        openMenu: (link, x, y) => menuRef.current?.open(link, x, y, processRef.current),
      },
      menu: (
        <TerminalLinkMenu
          ref={menuRef}
          onOpen={open}
          onOpenInBrowser={openInBrowser}
          onOpenInVibe={openInVibe}
          onOpenInProfile={openInProfile}
        />
      ),
    };
  }, [source]);
}

function copyLink(link: string): void {
  navigator.clipboard.writeText(link).then(
    () => notify.success({ title: t`Link copied` }),
    (error: unknown) =>
      notify.error({ title: t`Could not copy link`, message: errorMessage(error, t`Clipboard unavailable`), forceToast: true }),
  );
}

/** Owns the menu state, so opening and closing re-renders only this. */
const TerminalLinkMenu = forwardRef<
  LinkMenuHandle,
  {
    onOpen: (link: string) => void;
    onOpenInBrowser: (link: string) => void;
    onOpenInVibe: (link: string, host: AgenticProcess) => void;
    onOpenInProfile: (link: string, browser: string, profile: string) => void;
  }
>(function TerminalLinkMenu({ onOpen, onOpenInBrowser, onOpenInVibe, onOpenInProfile }, ref) {
  // `id` remounts the menu so a right-click on another link re-anchors it.
  const [state, setState] = useState<{
    link: string;
    x: number;
    y: number;
    host: AgenticProcess | null;
    id: number;
  } | null>(null);
  useImperativeHandle(ref, () => ({
    open: (link, x, y, host) => setState((prev) => ({ link, x, y, host, id: (prev?.id ?? 0) + 1 })),
  }), []);
  // Refetched on every open; the last list stays shown meanwhile, so only the first right-click waits.
  const [browsers, setBrowsers] = useState<Browser[]>([]);
  const opened = state !== null;
  useEffect(() => {
    if (!opened) return;
    let live = true;
    void fetchBrowserProfiles().then((list) => live && setBrowsers(list));
    return () => {
      live = false;
    };
  }, [opened]);

  if (!state) return null;
  const { link, x, y, host, id } = state;
  return (
    <DropdownMenu key={id} open modal={false} onOpenChange={(open) => !open && setState(null)}>
      <DropdownMenuTrigger asChild>
        <span aria-hidden style={{ position: 'fixed', left: x, top: y, width: 0, height: 0 }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-sm" data-testid="terminal-link-menu">
        <DropdownMenuLabel className="truncate text-xs font-normal text-muted-foreground" title={link}>
          {link}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => copyLink(link)}>
          <Copy className="mr-2 h-4 w-4" />
          {t`Copy`}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onOpen(link)}>
          <PanelTop className="mr-2 h-4 w-4" />
          {t`Open in Flowpad`}
        </DropdownMenuItem>
        {host && (
          <DropdownMenuItem onSelect={() => onOpenInVibe(link, host)} data-testid="terminal-link-menu-vibe">
            <Sparkles className="mr-2 h-4 w-4" />
            {t`Vibe`}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => onOpenInBrowser(link)}>
          <ExternalLink className="mr-2 h-4 w-4" />
          {t`Open in browser`}
        </DropdownMenuItem>
        {browsers.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-testid="terminal-link-menu-open-in">
              <AppWindow className="mr-2 h-4 w-4" />
              {t`Open in`}
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent className="max-w-xs">
                {browsers.map((browser, i) => (
                  <div key={browser.id} role="group" aria-label={browser.name}>
                    {i > 0 && <DropdownMenuSeparator />}
                    <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                      {browser.name}
                    </DropdownMenuLabel>
                    {browser.profiles.map((profile) => (
                      <DropdownMenuItem
                        key={profile.id}
                        onSelect={() => onOpenInProfile(link, browser.id, profile.id)}
                        data-testid={`terminal-link-menu-profile-${browser.id}-${profile.id}`}
                        title={profile.email ?? profile.name}
                      >
                        <span className="truncate">
                          {profile.name}
                          {profile.email && profile.email !== profile.name && (
                            <span className="text-muted-foreground"> — {profile.email}</span>
                          )}
                        </span>
                      </DropdownMenuItem>
                    ))}
                  </div>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
