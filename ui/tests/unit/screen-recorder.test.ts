/**
 * The top bar's screen recorder store: the OS picker starts a MediaRecorder, a stop
 * (the button or the OS "Stop sharing" bar) uploads the WebM into the recordings folder
 * the backend names, a refusal is one transient toast, and Save moves the dialog's
 * subject to the new place.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  callAction: vi.fn(),
  uploadFiles: vi.fn(),
}));
vi.mock('@sdk', () => ({
  ActionInfo: class {
    bodyParameters: unknown;
    constructor(public name: string, public type: unknown, public id: unknown, public method: string) {}
  },
  AgenticProcess: { type: 'agentic_process' },
  dataManager: { callAction: sdk.callAction },
  fsStore: { getState: () => ({ uploadFiles: sdk.uploadFiles }) },
  TypeId: class {
    constructor(public raw: string) {}
    toString() { return this.raw; }
  },
}));
const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('@src/notifications/notify', () => ({ notify: toasts }));
vi.mock('@src/notifications/command-registry', () => ({ registerCommand: vi.fn() }));

import {
  dismissRecording,
  formatElapsed,
  getRecorderState,
  recordingFileName,
  resetScreenRecorder,
  setRecordingPlace,
  startRecording,
  stopRecording,
} from '@src/components/top-nav-bar/use-screen-recorder';

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static isTypeSupported = (m: string) => m === 'video/webm;codecs=vp9';
  state: 'inactive' | 'recording' = 'inactive';
  mimeType: string;
  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(public stream: unknown, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType ?? '';
    FakeRecorder.instances.push(this);
  }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['webm-bytes']) });
    this.onstop?.();
  }
}

function fakeStream() {
  const listeners: Record<string, () => void> = {};
  const track = { stop: vi.fn(), addEventListener: (ev: string, fn: () => void) => { listeners[ev] = fn; } };
  return { stream: { getTracks: () => [track], getVideoTracks: () => [track] }, track, end: () => listeners.ended?.() };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('screen recorder', () => {
  let display: ReturnType<typeof fakeStream>;
  let getDisplayMedia: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    resetScreenRecorder();
    FakeRecorder.instances = [];
    display = fakeStream();
    (window as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeRecorder;
    (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeRecorder;
    getDisplayMedia = vi.fn().mockResolvedValue(display.stream);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia } });
    (globalThis.URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => 'blob:preview');
    revokeObjectURL = vi.fn();
    (globalThis.URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeObjectURL;
    sdk.callAction.mockResolvedValue({ abs_path: '/tmp/flowpad_temp/oss/recordings', compute_node_id: 'compute_node-n1' });
    sdk.uploadFiles.mockResolvedValue([{ waitForCompletion: () => Promise.resolve() }]);
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('records video only through the OS picker and uploads on stop', async () => {
    await startRecording();
    expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: false });
    expect(getRecorderState().phase).toBe('recording');
    expect(FakeRecorder.instances[0].mimeType).toBe('video/webm;codecs=vp9');

    stopRecording();
    await flush();

    expect(display.track.stop).toHaveBeenCalled();
    expect(sdk.callAction.mock.calls[0][0].name).toBe('recording-folder');
    const [node, dir, files] = sdk.uploadFiles.mock.calls[0];
    expect(String(node)).toBe('compute_node-n1');
    expect(dir).toBe('/tmp/flowpad_temp/oss/recordings');
    expect(files[0].name).toMatch(/^screen-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.webm$/);
    const state = getRecorderState();
    expect(state.phase).toBe('ready');
    expect(state.busy).toBe(false);
    expect(state.recording?.absPath).toBe(`/tmp/flowpad_temp/oss/recordings/${files[0].name}`);
  });

  it('the OS "Stop sharing" bar ends the recording too', async () => {
    await startRecording();
    display.end();
    await flush();
    expect(getRecorderState().phase).toBe('ready');
  });

  it('a second start while recording is ignored', async () => {
    await startRecording();
    await startRecording();
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
  });

  it('a cancelled picker stays quiet; another failure is one transient toast', async () => {
    const err = new Error('cancelled'); err.name = 'NotAllowedError';
    getDisplayMedia.mockRejectedValueOnce(err);
    await startRecording();
    expect(getRecorderState().phase).toBe('idle');
    expect(toasts.error).not.toHaveBeenCalled();

    getDisplayMedia.mockRejectedValueOnce(new Error('NotSupported'));
    await startRecording();
    expect(getRecorderState().phase).toBe('idle');
    expect(toasts.error).toHaveBeenCalledTimes(1);
    expect(toasts.error.mock.calls[0][0]).toMatchObject({ transient: true });
    expect(toasts.error.mock.calls[0][0].actions).toBeUndefined();
  });

  it('on the desktop a denied macOS grant toasts with Open System Settings and never asks the picker', async () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      screenCaptureStatus: vi.fn().mockResolvedValue('denied'),
      openScreenRecordingSettings: vi.fn(),
    };
    await startRecording();
    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(getRecorderState().phase).toBe('idle');
    expect(toasts.error.mock.calls[0][0].actions).toEqual([{ label: 'Open System Settings', command: 'screen-recording.open-settings' }]);
  });

  it('an upload failure toasts and returns to idle', async () => {
    sdk.uploadFiles.mockRejectedValueOnce(new Error('disk full'));
    await startRecording();
    stopRecording();
    await flush();
    expect(getRecorderState().phase).toBe('idle');
    expect(toasts.error.mock.calls[0][0].message).toBe('disk full');
  });

  it('Save moves the subject; dismiss revokes the preview and clears', async () => {
    await startRecording();
    stopRecording();
    await flush();
    setRecordingPlace({ absPath: '/proj/recordings/x.webm', computeNodeId: 'compute_node-n1' });
    expect(getRecorderState().recording).toMatchObject({ absPath: '/proj/recordings/x.webm', computeNodeId: 'compute_node-n1' });
    dismissRecording();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview');
    expect(getRecorderState()).toEqual({ phase: 'idle', busy: false, startedAt: null, recording: null });
  });

  it('names and formats', () => {
    expect(recordingFileName(new Date(Date.UTC(2026, 10, 2, 13, 26, 5, 123)))).toBe('screen-2026-11-02T13-26-05-123Z.webm');
    expect(formatElapsed(42_000)).toBe('00:42');
    expect(formatElapsed(61_500)).toBe('01:01');
  });
});
