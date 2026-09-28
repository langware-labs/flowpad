/**
 * Main window ⇄ popped-out assistant, over one BroadcastChannel.
 *
 *   popout: hello                 → main answers with its current dock
 *   main:   dock {url}            → on every navigation while a popout is alive
 *   popout: alive (heartbeat)     → main keeps its floating chat closed
 *   popout: bye                   → main may float the chat again
 *   main:   ask {text, files}     → a prompt for the popout (agent page request line)
 *   main:   focus                 → the popout raises itself
 *
 * Client-side only, like the popout handoff (tabs/popout-handoff.ts): a window
 * is a per-client concept. `File` objects survive the structured clone.
 */
export const ASSISTANT_CHANNEL = 'flowpad-assistant';

/** `/win/assistant?chat=<url>` — the page whose chat was showing when it popped out. */
export const ASSISTANT_CHAT_PARAM = 'chat';

/** Heartbeat period, and how long without one before the popout is presumed gone. */
export const ASSISTANT_HEARTBEAT_MS = 2_000;
export const ASSISTANT_ALIVE_TTL_MS = 5_000;

export type AssistantChannelMessage =
  | { kind: 'hello' }
  | { kind: 'dock'; url: string }
  | { kind: 'alive' }
  | { kind: 'bye' }
  | { kind: 'ask'; text: string; files?: File[]; url: string }
  | { kind: 'focus' };

export function openAssistantChannel(onMessage: (msg: AssistantChannelMessage) => void): {
  post: (msg: AssistantChannelMessage) => void;
  close: () => void;
} {
  if (typeof BroadcastChannel === 'undefined') return { post: () => {}, close: () => {} };
  const channel = new BroadcastChannel(ASSISTANT_CHANNEL);
  channel.onmessage = (e: MessageEvent<AssistantChannelMessage>) => onMessage(e.data);
  return {
    post: (msg) => {
      try {
        channel.postMessage(msg);
      } catch (err) {
        console.error('[assistant-channel] post failed', err);
      }
    },
    close: () => channel.close(),
  };
}
