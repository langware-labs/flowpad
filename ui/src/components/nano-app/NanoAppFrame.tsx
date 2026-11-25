import { useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from 'next-themes';
import { FlowMessage, fsManager, NANO_OPEN_MESSAGE, NANO_SIZE_MESSAGE } from '@sdk';
import { withStateKey } from '@sdk/page-state';
import { dockPointerForLocalFile } from '@src/components/conversation/attachment-url';
import { PREVIEW_SANDBOX } from '@src/components/html-preview/HtmlPreview';
import { hostBrand } from '@src/hooks/flow-hooks';
import { STATE_KEY_PARAM } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { LOCAL_COMPUTE_NODE } from '@src/navigation/asset-doc-types';

/** A block grows with its content up to this, then scrolls inside. An app keeps its own long lists shorter
 *  (the review table scrolls after about 8 rows), so this is the ceiling, not the usual height. */
export const NANO_BLOCK_MAX_HEIGHT = 800;

/** A message's key is the same for as long as the backend runs: asked once per message, not once per mount. */
const keys = new Map<string, Promise<string>>();
function appKeyOf(messageId: string): Promise<string> {
  let asked = keys.get(messageId);
  if (!asked) {
    asked = FlowMessage.appKey(messageId);
    keys.set(messageId, asked);
    asked.catch(() => keys.delete(messageId));
  }
  return asked;
}

/**
 * A nano-app (one `.html` file, `ts_sdk/src/apps/nano.ts`) shown in place: its `block` slot, with a shown `.html`'s
 * sandbox. The frame is as tall as the app says its content is (`flowpad:nano-size`), up to the ceiling. When the app asks for its page
 * (`flowpad:nano-open`) the file opens in a tab — the host navigates, the app never does. Only this frame's own
 * document is listened to.
 *
 * The app is handed ONE thing: the state key of the message that carries it (`FlowMessage.appKey`). The key
 * names the message, and the app reads what it was opened on through it — so the frame loads once the key is
 * here, and the page tab is opened with the same key. `path` is the app file's machine path on this computer.
 */
export function NanoAppFrame({ path, messageId, title }: { path: string; messageId: string; title?: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const { navigation } = useDockNavigation();
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === 'dark' ? 'dark' : 'light';
  // The theme in the address is for the first paint only; a later change is pushed (`flowpad:theme`),
  // so the address — and with it the loaded app — stays the same.
  const [firstTheme] = useState(theme);
  const [key, setKey] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setKey(null);
    void appKeyOf(messageId).then((minted) => current && setKey(minted));
    return () => void (current = false);
  }, [messageId]);
  const src = useMemo(() => {
    const query = new URLSearchParams({ slot: 'block', theme: firstTheme });
    return key ? withStateKey(`${fsManager.getServeUrl(LOCAL_COMPUTE_NODE, path)}?${query}`, key) : undefined;
  }, [path, key, firstTheme]);
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
        // The page opens with the same key as the block, so on the same message.
        navigation.openDock(dockPointerForLocalFile(path).withOption(STATE_KEY_PARAM, key));
    };
    window.addEventListener('message', onGuest);
    return () => window.removeEventListener('message', onGuest);
  }, [theme, path, key, navigation]);

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
