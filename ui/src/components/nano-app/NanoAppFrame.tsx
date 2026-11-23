import { useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from 'next-themes';
import { fsManager, NANO_OPEN_MESSAGE, NANO_SIZE_MESSAGE } from '@sdk';
import { withStateKey } from '@sdk/page-state';
import { dockPointerForLocalFile } from '@src/components/conversation/attachment-url';
import { PREVIEW_SANDBOX } from '@src/components/html-preview/HtmlPreview';
import { hostBrand } from '@src/hooks/flow-hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { LOCAL_COMPUTE_NODE } from '@src/navigation/asset-doc-types';

/** A block grows with its content up to this, then scrolls inside. An app keeps its own long lists shorter
 *  (the review table scrolls after about 8 rows), so this is the ceiling, not the usual height. */
export const NANO_BLOCK_MAX_HEIGHT = 800;

/**
 * A nano-app (one `.html` file, `ts_sdk/src/apps/nano.ts`) shown in place: its `block` slot, with a shown `.html`'s
 * sandbox. The frame is as tall as the app says its content is (`flowpad:nano-size`), up to the ceiling. When the app asks for its page
 * (`flowpad:nano-open`) the file opens in a tab — the host navigates, the app never does. Only this frame's own
 * document is listened to.
 *
 * `path` and `input` are plain machine paths on this computer; `input` is the value file the app opens on.
 */
export function NanoAppFrame({ path, input, title }: { path: string; input?: string; title?: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const { navigation } = useDockNavigation();
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === 'dark' ? 'dark' : 'light';
  // The theme in the address is for the first paint only; a later change is pushed (`flowpad:theme`),
  // so the address — and with it the loaded app — stays the same.
  const [firstTheme] = useState(theme);
  const src = useMemo(() => {
    const query = new URLSearchParams({ slot: 'block', theme: firstTheme, ...(input ? { input } : {}) });
    return withStateKey(`${fsManager.getServeUrl(LOCAL_COMPUTE_NODE, path)}?${query}`);
  }, [path, input, firstTheme]);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const pushSkin = () => frame.current?.contentWindow?.postMessage({ type: 'flowpad:theme', theme, ...hostBrand() }, '*');
    pushSkin();
    const onGuest = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const data = event.data as { type?: string; height?: unknown; slot?: unknown } | null;
      if (data?.type === 'flowpad:skin-please') pushSkin();
      else if (data?.type === NANO_SIZE_MESSAGE && typeof data.height === 'number') setHeight(data.height);
      else if (data?.type === NANO_OPEN_MESSAGE && data.slot === 'page')
        // The page opens on the same value as the block: the tab's `input` option becomes the page's `?input=`.
        navigation.openDock(dockPointerForLocalFile(path).withOption('input', input ?? null));
    };
    window.addEventListener('message', onGuest);
    return () => window.removeEventListener('message', onGuest);
  }, [theme, path, input, navigation]);

  return (
    <iframe
      ref={frame}
      src={src}
      title={title ?? 'App'}
      sandbox={PREVIEW_SANDBOX}
      data-testid="nano-app-frame"
      className="block w-full rounded-md border border-border bg-background"
      style={{ height: Math.min(height, NANO_BLOCK_MAX_HEIGHT) }}
    />
  );
}
