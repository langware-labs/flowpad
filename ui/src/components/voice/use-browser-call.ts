/**
 * A voice call from this browser: the microphone in, the agent's voice out.
 *
 * The browser never holds a provider key. It makes a WebRTC offer and hands it to the source's
 * call route (`POST /api/v1/data_source/<id>/call`, `{offer: {sdp}}`); the backend creates the call
 * with its own key and answers with the provider's SDP. Audio then flows peer-to-peer between this
 * browser and the provider — the backend only holds the call's control channel, which is where the
 * sentences come from that land in the conversation.
 *
 * **The call outlives the control that started it.** Watching the call happen means opening its
 * conversation, which unmounts the channel bar the call was started from — so the call is held here,
 * one per source, not in a component: navigating keeps the mic open and the voice playing, and
 * coming back finds the call where it was. Only `end` (or the line closing) ends it, and `end` asks
 * the backend to hang up (`…/call/<id>/hangup`).
 */
import { useCallback, useSyncExternalStore } from 'react';
import apiClient from '@sdk/client';

export type BrowserCallState = 'idle' | 'mic' | 'connecting' | 'live' | 'ended' | 'error';

interface CallAnswer {
  sdp: string;
  call_id: string;
}

interface Snapshot {
  state: BrowserCallState;
  error: string | null;
  callId: string | null;
}

class BrowserCall {
  snapshot: Snapshot = { state: 'idle', error: null, callId: null };
  private readonly listeners = new Set<() => void>();
  private peer: RTCPeerConnection | null = null;
  private mic: MediaStream | null = null;
  private speaker: HTMLAudioElement | null = null;

  constructor(private readonly sourceId: string) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(next: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...next };
    this.listeners.forEach((listener) => listener());
  }

  private release() {
    this.peer?.close();
    this.peer = null;
    this.mic?.getTracks().forEach((track) => track.stop());
    this.mic = null;
    if (this.speaker) this.speaker.srcObject = null;
  }

  end = () => {
    // The backend holds the call: it hangs up, so the provider closes the line and the call is
    // recorded as ended now — not whenever the provider notices this peer went quiet.
    const callId = this.snapshot.callId;
    if (callId && this.peer) {
      void apiClient.post(`/api/v1/data_source/${this.sourceId}/call/${callId}/hangup`, {}).catch(() => {});
    }
    this.release();
    if (this.snapshot.state !== 'error') this.set({ state: 'ended' });
  };

  start = async (caller: { id: string; name?: string }) => {
    if (this.peer) return;
    this.set({ state: 'mic', error: null, callId: null });
    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.mic = mic;
      this.set({ state: 'connecting' });
      const pc = new RTCPeerConnection();
      this.peer = pc;
      mic.getTracks().forEach((track) => pc.addTrack(track, mic));
      this.speaker ??= new Audio();
      this.speaker.autoplay = true;
      pc.ontrack = (event) => {
        if (this.speaker) this.speaker.srcObject = event.streams[0] ?? null;
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') this.set({ state: 'live' });
        else if (['failed', 'closed', 'disconnected'].includes(pc.connectionState) && this.peer === pc) this.end();
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const answer = (await apiClient.post(`/api/v1/data_source/${this.sourceId}/call`, {
        offer: { sdp: offer.sdp, caller: caller.id, caller_name: caller.name ?? '' },
      })) as unknown as CallAnswer;
      this.set({ callId: answer.call_id });
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    } catch (err) {
      this.release();
      this.set({ state: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  };

  /** The live peer's stats (bytes heard, levels), or null when no call is up. */
  stats = async () => (this.peer ? this.peer.getStats() : null);
}

/** One call per source, for the life of the page. */
const calls = new Map<string, BrowserCall>();

function callFor(sourceId: string): BrowserCall {
  let call = calls.get(sourceId);
  if (!call) {
    call = new BrowserCall(sourceId);
    calls.set(sourceId, call);
  }
  return call;
}

const IDLE: Snapshot = { state: 'idle', error: null, callId: null };
const NOTHING = () => () => {};

export function useBrowserCall(sourceId: string | undefined, caller: { id: string; name?: string }) {
  const call = sourceId ? callFor(sourceId) : null;
  const snapshot = useSyncExternalStore(call?.subscribe ?? NOTHING, () => call?.snapshot ?? IDLE);
  const start = useCallback(async () => {
    await call?.start(caller);
  }, [call, caller.id, caller.name]); // eslint-disable-line react-hooks/exhaustive-deps
  const end = useCallback(() => call?.end(), [call]);
  const stats = useCallback(async () => (call ? call.stats() : null), [call]);
  return { ...snapshot, start, end, stats };
}

/** Test seam: forget every call (each test starts from a page with none). */
export function resetBrowserCalls(): void {
  calls.forEach((call) => call.end());
  calls.clear();
}
