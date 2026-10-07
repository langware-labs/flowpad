import type { AgenticProcess } from '@sdk';
import { t } from '@lingui/core/macro';
import { AppWindow, Copy, ExternalLink, Monitor, PanelTop, Sparkles } from 'lucide-react';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
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
import { MediaLightbox } from '@src/components/ui/media-lightbox';
import { BrowserProfileItems } from './BrowserProfileItems';
import { fetchBrowserProfiles, type Browser } from '@src/lib/browser-profiles';
import { lightboxMediaName, linkKind } from '@src/lib/link-kind';
import { linkActions, type LinkActionId, type LinkSurface } from './link-actions';
import type { LinkHandlers, LinkSource } from './link-events';
import { runLinkAction, type LinkAction, type LinkMedia } from './link-handlers';
import { useDockNavigation } from '@src/navigation';

export interface Links {
  /** Stable for the surface's lifetime. */
  handlers: LinkHandlers;
  /** Render beside the surface; stable, so the surface never re-renders for the menu. */
  menu: ReactNode;
}

export interface LinkOptions {
  /** `vibe` only for the surface whose process owns the vibe Display it sits beside. */
  surface?: LinkSurface;
}

interface LinkMenuHandle {
  open: (link: string, x: number, y: number, items: LinkActionId[]) => void;
}

interface LinkPreviewHandle {
  show: (media: LinkMedia) => void;
}

/**
 * A link surface's click and right-click, composed from the three layers: what the link
 * is (`link-kind`), what can be done with it (`linkActions`), and the one runner
 * (`runLinkAction`). Click runs the primary action; right-click lists the menu. Every
 * link surface (terminal, message, chat) shares this.
 */
export function useLinks(
  source: RefObject<LinkSource | null>,
  process?: AgenticProcess | null,
  { surface = 'tab' }: LinkOptions = {},
): Links {
  const { navigation } = useDockNavigation();
  // Read the current navigation/process without retaining a surface render's closure.
  const navRef = useRef(navigation);
  navRef.current = navigation;
  const processRef = useRef(process ?? null);
  processRef.current = process ?? null;
  const menuRef = useRef<LinkMenuHandle>(null);
  const previewRef = useRef<LinkPreviewHandle>(null);

  return useMemo(() => {
    const plan = (link: string) =>
      linkActions({
        kind: linkKind(link, window.location.origin),
        media: lightboxMediaName(link) !== null,
        surface,
        host: processRef.current !== null,
      });
    const run = (action: LinkAction, link: string) =>
      void runLinkAction(action, link, {
        navigation: navRef.current,
        source: source.current,
        host: processRef.current,
        preview: (media) => previewRef.current?.show(media),
      });
    return {
      handlers: {
        activate: (_event, link) => run({ id: plan(link).primary } as LinkAction, link),
        openMenu: (link, x, y) => menuRef.current?.open(link, x, y, plan(link).menu),
      },
      menu: (
        <>
          <LinkMenu ref={menuRef} onRun={run} />
          <LinkPreview ref={previewRef} />
        </>
      ),
    };
  }, [source, surface]);
}

/** Owns the preview state, so showing and closing re-renders only this. */
const LinkPreview = forwardRef<LinkPreviewHandle>(function LinkPreview(_props, ref) {
  const [media, setMedia] = useState<LinkMedia | null>(null);
  useImperativeHandle(ref, () => ({ show: setMedia }), []);
  const close = useCallback(() => setMedia(null), []);
  return media ? <MediaLightbox url={media.url} name={media.name} onClose={close} /> : null;
});

type MenuItemId = Exclude<LinkActionId, 'browser-profile' | 'preview'>;

/** How each action reads in the menu. `browser-profile` is the "Open in ▸" submenu. */
const ITEMS: Record<MenuItemId, { label: () => string; icon: typeof Copy }> = {
  copy: { label: () => t`Copy`, icon: Copy },
  'show-in-display': { label: () => t`Show in Display`, icon: Monitor },
  open: { label: () => t`Open in Flowpad`, icon: PanelTop },
  vibe: { label: () => t`Vibe`, icon: Sparkles },
  browser: { label: () => t`Open in browser`, icon: ExternalLink },
};

/** Owns the menu state, so opening and closing re-renders only this. */
const LinkMenu = forwardRef<LinkMenuHandle, { onRun: (action: LinkAction, link: string) => void }>(function LinkMenu(
  { onRun },
  ref,
) {
  // `id` remounts the menu so a right-click on another link re-anchors it.
  const [state, setState] = useState<{ link: string; x: number; y: number; items: LinkActionId[]; id: number } | null>(
    null,
  );
  useImperativeHandle(
    ref,
    () => ({
      open: (link, x, y, items) => setState((prev) => ({ link, x, y, items, id: (prev?.id ?? 0) + 1 })),
    }),
    [],
  );
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
  const { link, x, y, items, id } = state;
  return (
    <DropdownMenu key={id} open modal={false} onOpenChange={(open) => !open && setState(null)}>
      <DropdownMenuTrigger asChild>
        <span aria-hidden style={{ position: 'fixed', left: x, top: y, width: 0, height: 0 }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-sm" data-testid="link-menu">
        <DropdownMenuLabel className="truncate text-xs font-normal text-muted-foreground" title={link}>
          {link}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.map((item) => {
          if (item === 'preview') return null;
          if (item === 'browser-profile') {
            return browsers.length > 0 ? (
              <DropdownMenuSub key={item}>
                <DropdownMenuSubTrigger data-testid="link-menu-open-in">
                  <AppWindow className="mr-2 h-4 w-4" />
                  {t`Open in`}
                </DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent className="max-w-xs">
                    <BrowserProfileItems
                      browsers={browsers}
                      onSelect={(browser, profile) => onRun({ id: 'browser-profile', browser, profile }, link)}
                      testIdPrefix="link-menu-profile"
                    />
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
            ) : null;
          }
          const { label, icon: Icon } = ITEMS[item];
          return (
            <DropdownMenuItem key={item} onSelect={() => onRun({ id: item }, link)} data-testid={`link-menu-${item}`}>
              <Icon className="mr-2 h-4 w-4" />
              {label()}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
