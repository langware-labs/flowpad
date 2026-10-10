import flowpadIcon from '@src/assets/flowpad-icon.png';
import { DockPointer } from '@src/navigation/DockPointer';
import { Trans } from '@lingui/react/macro';
import { useCallback, useEffect, useState } from 'react';
import { AssistantChat } from './AssistantChat';
import { ASSISTANT_CHAT_PARAM, ASSISTANT_HEARTBEAT_MS, openAssistantChannel } from './assistant-channel';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import type { PendingAsk } from './floating-chat-context';

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}

/**
 * `/win/assistant` — the Flowpad Assistant popped out of its floating window.
 *
 * It follows the MAIN window, not its own URL: the main window posts its dock
 * on every navigation (assistant-channel.ts), and this window binds the chat to
 * it under the same rules as the floating one. It heartbeats so the main window
 * keeps its floating chat closed while this one is open.
 */
export default function AssistantPopoutView() {
  const visible = useDocumentVisible();
  const { currentDock } = useDockNavigation();
  // Continue the chat that was showing when the user popped it out.
  const [initialDock] = useState<DockPointer | null>(() => {
    const url = currentDock?.options?.[ASSISTANT_CHAT_PARAM];
    return url ? DockPointer.fromUrl(url) : null;
  });
  const [followedDock, setFollowedDock] = useState<DockPointer | null>(null);
  const [pendingAsk, setPendingAsk] = useState<PendingAsk | null>(null);

  useEffect(() => {
    const channel = openAssistantChannel((msg) => {
      if (msg.kind === 'dock') setFollowedDock(DockPointer.fromUrl(msg.url));
      else if (msg.kind === 'ask') setPendingAsk({ text: msg.text, files: msg.files, url: msg.url, nonce: Date.now() });
      else if (msg.kind === 'focus') window.focus();
    });
    channel.post({ kind: 'hello' });
    const beat = setInterval(() => channel.post({ kind: 'alive' }), ASSISTANT_HEARTBEAT_MS);
    const bye = () => channel.post({ kind: 'bye' });
    window.addEventListener('pagehide', bye);
    return () => {
      clearInterval(beat);
      window.removeEventListener('pagehide', bye);
      bye();
      channel.close();
    };
  }, []);

  const consumeAsk = useCallback((nonce: number) => {
    setPendingAsk((prev) => (prev?.nonce === nonce ? null : prev));
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="assistant-popout">
      <div className="flex flex-shrink-0 items-center gap-2 border-b bg-muted/40 px-2 py-1.5">
        <img src={flowpadIcon} alt="" className="h-5 w-5 flex-shrink-0 object-contain" />
        <span className="flex-1 truncate text-xs font-medium">
          <Trans>Flowpad Assistant</Trans>
        </span>
      </div>
      <AssistantChat
        followedDock={followedDock}
        // Nothing to follow until the main window answers `hello`.
        visible={visible && followedDock !== null}
        pendingAsk={pendingAsk}
        onAskConsumed={consumeAsk}
        initialDock={initialDock}
      />
    </div>
  );
}
