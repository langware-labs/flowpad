import type { Shell } from '@sdk';
import { t } from '@lingui/core/macro';
import { Copy, ExternalLink, PanelTop } from 'lucide-react';
import { forwardRef, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@src/components/ui/dropdown-menu';
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
  open: (link: string, x: number, y: number) => void;
}

/** Click opens a link in Flowpad; right-click offers copy / open in Flowpad / open in browser. */
export function useTerminalLinks(source: RefObject<Shell | null>): TerminalLinks {
  const { navigation } = useDockNavigation();
  // Read the current navigation/source without retaining a terminal render's closure.
  const navRef = useRef(navigation);
  navRef.current = navigation;
  const menuRef = useRef<LinkMenuHandle>(null);

  return useMemo(() => {
    const open = (link: string) => void navRef.current.openLink(link, source.current);
    const openInBrowser = (link: string) => void navRef.current.openLinkInBrowser(link, source.current);
    return {
      handlers: {
        activate: (_event, link) => open(link),
        openMenu: (link, x, y) => menuRef.current?.open(link, x, y),
      },
      menu: <TerminalLinkMenu ref={menuRef} onOpen={open} onOpenInBrowser={openInBrowser} />,
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
  { onOpen: (link: string) => void; onOpenInBrowser: (link: string) => void }
>(function TerminalLinkMenu({ onOpen, onOpenInBrowser }, ref) {
  // `id` remounts the menu so a right-click on another link re-anchors it.
  const [state, setState] = useState<{ link: string; x: number; y: number; id: number } | null>(null);
  useImperativeHandle(ref, () => ({
    open: (link, x, y) => setState((prev) => ({ link, x, y, id: (prev?.id ?? 0) + 1 })),
  }), []);

  if (!state) return null;
  const { link, x, y, id } = state;
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
        <DropdownMenuItem onSelect={() => onOpenInBrowser(link)}>
          <ExternalLink className="mr-2 h-4 w-4" />
          {t`Open in browser`}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
