/**
 * The call controls: one per channel that takes calls, drawn from the driver's `calls` alone — and
 * each starts its call through the source's call route (never a provider URL), carrying exactly
 * what that way of calling needs: a browser's SDP offer, a clip's bytes, a number and a purpose.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataDriver, DataSource } from '@sdk';

const post = vi.fn();
vi.mock('@sdk/client', () => ({ default: { post: (...args: unknown[]) => post(...args) } }));
vi.mock('@src/components/conversation/useLocalUser', () => ({ useLocalUser: () => ({ localUser: { id: 'u1', name: 'Ada' } }) }));

import { CallControls, callableSources } from '@src/components/voice/CallControls';
import { resetBrowserCalls } from '@src/components/voice/use-browser-call';

const AGENT = 'agent-22222222-2222-4222-8222-222222222222';
const uuidOf = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;
const source = (n: number, provider: string, name: string) =>
  new DataSource({ id: uuidOf(n), name, provider, channel: 'voice', owner: AGENT, status: 'active' as DataSource['status'] });
const SPECS: Record<string, DataDriver> = {
  line_webrtc: new DataDriver({ name: 'line_webrtc', sends: true, calls: 'webrtc' } as never),
  line_clip: new DataDriver({ name: 'line_clip', sends: true, calls: 'clip' } as never),
  line_dial: new DataDriver({ name: 'line_dial', sends: true, calls: 'dial' } as never),
  chat_only: new DataDriver({ name: 'chat_only', sends: true } as never),
};
const specFor = (provider: string) => SPECS[provider];
const ROWS = [source(1, 'line_webrtc', 'Desk'), source(2, 'line_clip', 'Clips'), source(3, 'line_dial', 'Phone'), source(4, 'chat_only', 'Chat')];

function open(calls: string) {
  const button = screen.getAllByTestId('voice-call-button').find((b) => b.dataset.calls === calls)!;
  fireEvent.click(button);
  return button;
}

describe('CallControls', () => {
  beforeEach(() => {
    post.mockReset();
  });
  afterEach(cleanup);

  it('a driver says how a call starts — the list follows it, and a driver that takes no calls gets none', () => {
    expect(new DataDriver({ name: 'x', calls: 'clip' } as never).calls).toBe('clip');
    expect(callableSources(ROWS, specFor).map(({ source: s, calls }) => [s.name, calls])).toEqual([
      ['Desk', 'webrtc'],
      ['Clips', 'clip'],
      ['Phone', 'dial'],
    ]);
    render(<CallControls rows={ROWS} specFor={specFor} />);
    expect(screen.getAllByTestId('voice-call-button').map((b) => [b.dataset.calls, b.dataset.sourceId])).toEqual([
      ['webrtc', uuidOf(1)],
      ['clip', uuidOf(2)],
      ['dial', uuidOf(3)],
    ]);
  });

  it('renders nothing for an owner with no channel that takes calls', () => {
    const { container } = render(<CallControls rows={[ROWS[3]]} specFor={specFor} />);
    expect(container.innerHTML).toBe('');
  });

  it('dial: the number and what the call is for go to the source call route', async () => {
    post.mockResolvedValue({ call_sid: 'CA1', status: 'queued', to: '+972501234567', call_id: '' });
    render(<CallControls rows={ROWS} specFor={specFor} />);
    open('dial');
    fireEvent.change(screen.getByTestId('voice-dial-to'), { target: { value: '+972501234567' } });
    fireEvent.change(screen.getByTestId('voice-dial-brief'), { target: { value: 'Confirm the delivery.' } });
    fireEvent.click(screen.getByTestId('voice-dial-call'));
    await waitFor(() => expect(screen.getByTestId('voice-call-status').dataset.ok).toBe('true'));
    expect(post).toHaveBeenCalledWith(`/api/v1/data_source/${uuidOf(3)}/call`, { offer: { to: '+972501234567', brief: 'Confirm the delivery.' } });
    expect(screen.getByTestId('voice-call-status').textContent).toContain('+972501234567');
  });

  it('clip: the recording travels as its bytes, named, from this person', async () => {
    post.mockResolvedValue({ clip: '/x/in/question.wav', call_id: 'clip_1' });
    render(<CallControls rows={ROWS} specFor={specFor} />);
    open('clip');
    const file = new File([new Uint8Array([82, 73, 70, 70])], 'question.wav', { type: 'audio/wav' });
    fireEvent.change(screen.getByTestId('voice-clip-input'), { target: { files: [file] } });
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith(`/api/v1/data_source/${uuidOf(2)}/call`, {
      offer: { audio_b64: btoa('RIFF'), name: 'question.wav', caller: 'Ada' },
    });
    await waitFor(() => expect(screen.getByTestId('voice-call-status').dataset.ok).toBe('true'));
  });

  it('a refused start says why, in the panel', async () => {
    post.mockRejectedValue(new Error('Phone number must be E.164'));
    render(<CallControls rows={ROWS} specFor={specFor} />);
    open('dial');
    fireEvent.change(screen.getByTestId('voice-dial-to'), { target: { value: '+1' } });
    fireEvent.click(screen.getByTestId('voice-dial-call'));
    await waitFor(() => expect(screen.getByTestId('voice-call-status').dataset.ok).toBe('false'));
    expect(screen.getByTestId('voice-call-status').textContent).toBe('Phone number must be E.164');
  });
});

describe('browser call (mic + speakers)', () => {
  const tracks = [{ stop: vi.fn() }];
  const stream = { getTracks: () => tracks } as unknown as MediaStream;
  let peer: FakePeer;

  class FakePeer {
    connectionState = 'new';
    onconnectionstatechange: (() => void) | null = null;
    ontrack: ((e: { streams: MediaStream[] }) => void) | null = null;
    added: unknown[] = [];
    remote: RTCSessionDescriptionInit | null = null;
    closed = false;
    constructor() {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      peer = this;
    }
    addTrack(track: unknown) {
      this.added.push(track);
    }
    async createOffer() {
      return { type: 'offer', sdp: 'v=0 browser-offer' };
    }
    async setLocalDescription() {}
    async setRemoteDescription(d: RTCSessionDescriptionInit) {
      this.remote = d;
    }
    async getStats() {
      return new Map();
    }
    close() {
      this.closed = true;
    }
    connect() {
      this.connectionState = 'connected';
      this.onconnectionstatechange?.();
      this.ontrack?.({ streams: [stream] });
    }
  }

  beforeEach(() => {
    post.mockReset();
    tracks[0].stop.mockReset();
    vi.stubGlobal('RTCPeerConnection', FakePeer);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue(stream) } });
  });
  afterEach(() => {
    cleanup();
    resetBrowserCalls();
    vi.unstubAllGlobals();
  });

  it('offers the mic, applies the answer the backend brings back, goes live, and ending releases the mic', async () => {
    post.mockResolvedValue({ sdp: 'v=0 provider-answer', call_id: 'rtc_1' });
    render(<CallControls rows={ROWS} specFor={specFor} />);
    open('webrtc');
    expect(screen.getByTestId('voice-call-state').dataset.state).toBe('idle');
    fireEvent.click(screen.getByTestId('voice-call-start'));
    await waitFor(() => expect(peer.remote).not.toBeNull());
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(peer.added).toEqual(tracks);
    expect(post).toHaveBeenCalledWith(`/api/v1/data_source/${uuidOf(1)}/call`, {
      offer: { sdp: 'v=0 browser-offer', caller: 'Ada', caller_name: 'Ada' },
    });
    expect(peer.remote).toEqual({ type: 'answer', sdp: 'v=0 provider-answer' });
    act(() => peer.connect());
    expect(screen.getByTestId('voice-call-state').dataset.state).toBe('live');
    fireEvent.click(screen.getByTestId('voice-call-end'));
    expect(post).toHaveBeenLastCalledWith(`/api/v1/data_source/${uuidOf(1)}/call/rtc_1/hangup`, {});
    expect(peer.closed).toBe(true);
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(screen.getByTestId('voice-call-state').dataset.state).toBe('ended');
  });

  it('the call outlives the control: leaving the view keeps the mic and the voice, coming back finds it live', async () => {
    post.mockResolvedValue({ sdp: 'v=0 provider-answer', call_id: 'rtc_2' });
    const first = render(<CallControls rows={ROWS} specFor={specFor} />);
    open('webrtc');
    fireEvent.click(screen.getByTestId('voice-call-start'));
    await waitFor(() => expect(peer.remote).not.toBeNull());
    act(() => peer.connect());
    // Watching the call means opening its conversation — the channel bar goes away.
    first.unmount();
    expect(peer.closed).toBe(false);
    expect(tracks[0].stop).not.toHaveBeenCalled();
    render(<CallControls rows={ROWS} specFor={specFor} />);
    open('webrtc');
    expect(screen.getByTestId('voice-call-state').dataset.state).toBe('live');
  });

  it('a microphone the browser refuses is an error in the panel, and nothing is posted', async () => {
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Permission denied'));
    render(<CallControls rows={ROWS} specFor={specFor} />);
    open('webrtc');
    fireEvent.click(screen.getByTestId('voice-call-start'));
    await waitFor(() => expect(screen.getByTestId('voice-call-state').dataset.state).toBe('error'));
    expect(screen.getByTestId('voice-call-state').textContent).toBe('Permission denied');
    expect(post).not.toHaveBeenCalled();
  });
});
