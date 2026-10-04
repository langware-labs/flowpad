import { fsStore, type AgenticProcess } from '@sdk';
import { t } from '@lingui/core/macro';
import { AppWindow, Copy, ExternalLink, PanelTop, Sparkles } from 'lucide-react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
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
import { MediaLightbox, isLightboxMedia } from '@src/components/ui/media-lightbox';
import { fetchBrowserProfiles, type Browser } from '@src/lib/browser-profiles';
import { errorMessage } from '@src/lib/error-message';
import type { LinkHandlers, LinkSource } from './link-events';
import { useDockNavigation } from '@src/navigation';
import { notify } from '@src/notifications/notify';

export interface Links {
  /** Stable for the surface's lifetime. */
  handlers: LinkHandlers;
  /** Render beside the surface; stable, so the surface never re-renders for the menu. */
  menu: ReactNode;
}

interface LinkMenuHandle {
  open: (link: string, x: number, y: number, host: AgenticProcess | null) => void;
}

interface LinkPreviewHandle {
  show: (media: LinkMedia) => void;
}

interface LinkMedia {
  url: string;
  name: string;
}

/** A position suffix a terminal reference may carry: `a.png:3`, `a.png:3:7`, `a.png#L3`. */
const POSITION_SUFFIX = /(?::\d+(?::\d+)?|#L\d+)$/;

/**
 * The file name to preview a link by, or null when it is not an image or video.
 * A web URL is judged by its path (not its query); a file reference, without its position.
 */
export function lightboxMediaName(link: string): string | null {
  let name = link;
  if (/^https?:/i.test(link)) {
    try {
      name = new URL(link).pathname;
    } catch {
      return null;
    }
  } else {
    name = link.replace(POSITION_SUFFIX, '');
  }
  return isLightboxMedia(name) ? name.split(/[/\\]/).pop() || name : null;
}

/**
 * The bytes behind an image/video link: a web URL as itself, a file reference as the
 * source's own machine serves it (the path the backend resolved, on its compute node).
 */
async function mediaFor(link: string, source: LinkSource | null): Promise<LinkMedia | null> {
  const name = lightboxMediaName(link);
  if (!name) return null;
  if (/^https?:/i.test(link)) return { url: link, name };
  const node = source?.computeNodeTypeId;
  if (!source || !node) return null;
  const path = (await source.resolveDisplayTarget(link))?.path;
  return path ? { url: fsStore.getState().getDownloadUrl(node, path), name } : null;
}

/**
 * Click opens a link in Flowpad — an image or video in the in-app lightbox, anything else as a tab; right-click offers copy / open in Flowpad / open in browser / open in one
 * browser profile of this machine, and — when the surface belongs to a process — Vibe: that process in vibe
 * mode with the link as a tab. Every link surface (terminal, message) shares this.
 */
export function useLinks(source: RefObject<LinkSource | null>, process?: AgenticProcess | null): Links {
  const { navigation } = useDockNavigation();
  // Read the current navigation/source/process without retaining a surface render's closure.
  const navRef = useRef(navigation);
  navRef.current = navigation;
  const processRef = useRef(process ?? null);
  processRef.current = process ?? null;
  const menuRef = useRef<LinkMenuHandle>(null);
  const previewRef = useRef<LinkPreviewHandle>(null);

  return useMemo(() => {
    const open = (link: string) => void navRef.current.openLink(link, source.current);
    // Media previews in place; anything the preview can't resolve opens as a tab, which
    // also reports the failure the way every other link does.
    const activate = async (link: string) => {
      const media = await mediaFor(link, source.current).catch(() => null);
      if (media) previewRef.current?.show(media);
      else open(link);
    };
    const openInBrowser = (link: string) => void navRef.current.openLinkInBrowser(link, source.current);
    const openInVibe = (link: string, host: AgenticProcess) =>
      void navRef.current.openLinkInVibe(link, source.current, host);
    const openInProfile = (link: string, browser: string, profile: string) =>
      void navRef.current.openLinkInBrowserProfile(link, source.current, browser, profile);
    return {
      handlers: {
        activate: (_event, link) => void activate(link),
        openMenu: (link, x, y) => menuRef.current?.open(link, x, y, processRef.current),
      },
      menu: (
        <>
          <LinkMenu
            ref={menuRef}
            onOpen={open}
            onOpenInBrowser={openInBrowser}
            onOpenInVibe={openInVibe}
            onOpenInProfile={openInProfile}
          />
          <LinkPreview ref={previewRef} />
        </>
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

/** Owns the preview state, so showing and closing re-renders only this. */
const LinkPreview = forwardRef<LinkPreviewHandle>(function LinkPreview(_props, ref) {
  const [media, setMedia] = useState<LinkMedia | null>(null);
  useImperativeHandle(ref, () => ({ show: setMedia }), []);
  const close = useCallback(() => setMedia(null), []);
  return media ? <MediaLightbox url={media.url} name={media.name} onClose={close} /> : null;
});

/** Owns the menu state, so opening and closing re-renders only this. */
const LinkMenu = forwardRef<
  LinkMenuHandle,
  {
    onOpen: (link: string) => void;
    onOpenInBrowser: (link: string) => void;
    onOpenInVibe: (link: string, host: AgenticProcess) => void;
    onOpenInProfile: (link: string, browser: string, profile: string) => void;
  }
>(function LinkMenu({ onOpen, onOpenInBrowser, onOpenInVibe, onOpenInProfile }, ref) {
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
      <DropdownMenuContent align="start" className="max-w-sm" data-testid="link-menu">
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
          <DropdownMenuItem onSelect={() => onOpenInVibe(link, host)} data-testid="link-menu-vibe">
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
            <DropdownMenuSubTrigger data-testid="link-menu-open-in">
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
                        data-testid={`link-menu-profile-${browser.id}-${profile.id}`}
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
