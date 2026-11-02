import { useSyncExternalStore } from 'react';
import { t } from '@lingui/core/macro';
import { ActionInfo, dataManager } from '@sdk';
import { notify } from '@src/notifications/notify';
import { registerCommand } from '@src/notifications/command-registry';
import { stampedFileName } from '@src/utils/stamped-file-name';
import { uploadFilesToDir, type UploadDir } from '@src/utils/upload-to-input-dir';

/**
 * The top bar's screen recorder — one recording at a time for the whole window.
 *
 * `getDisplayMedia` (video only) feeds a `MediaRecorder`; the OS picker chooses the
 * screen. Stopping — from the bar's button or the OS "Stop sharing" bar — uploads the
 * WebM into Flowpad's recordings temp folder (the backend names it; the renderer never
 * spells a path) and hands the result to the "Recording ready" dialog.
 *
 * Module-level store, not component state: the bar re-renders on every dock navigation
 * and the timer must survive that. `useScreenRecorder` subscribes a component to it.
 */

export type RecorderPhase = 'idle' | 'recording' | 'ready';

/** Where the recording sits: the temp folder first, the project after Save. */
export interface RecordingPlace {
  absPath: string;
  computeNodeId: string;
}

export interface Recording extends RecordingPlace {
  file: File;
  /** An object URL for the dialog's preview; revoked when the recording is dismissed. */
  objectUrl: string;
  durationMs: number;
}

export interface RecorderState {
  phase: RecorderPhase;
  /** Waiting on the picker (before `recording`) or on the upload (before `ready`). */
  busy: boolean;
  /** When the current recording started (ms epoch); null outside `recording`. */
  startedAt: number | null;
  /** The finished recording the dialog shows; null until a stop completes. */
  recording: Recording | null;
}

interface ScreenCaptureWindow {
  electronAPI?: {
    screenCaptureStatus?: () => Promise<string>;
    openScreenRecordingSettings?: () => Promise<boolean>;
  };
}

const IDLE: RecorderState = { phase: 'idle', busy: false, startedAt: null, recording: null };

let state: RecorderState = IDLE;
const listeners = new Set<() => void>();
let active: { recorder: MediaRecorder; stream: MediaStream; chunks: Blob[] } | null = null;

function set(next: Partial<RecorderState>): void {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

function electronAPI() {
  return (window as unknown as ScreenCaptureWindow).electronAPI;
}

/** The toast action: open the macOS pane that holds the grant (desktop app only). */
registerCommand('screen-recording.open-settings', () => {
  void electronAPI()?.openScreenRecordingSettings?.();
});

function failToast(title: string, error: unknown): void {
  notify.error({ title, message: error instanceof Error ? error.message : String(error), transient: true });
}

/** macOS refused the app (the status read said so): the app cannot re-prompt, only point at the pane. */
function macDeniedToast(): void {
  notify.error({
    id: 'screen-recording:denied',
    title: t`Screen recording is not allowed`,
    message: t`macOS blocks Flowpad from recording the screen. Allow it under Privacy & Security › Screen & System Audio Recording, then try again.`,
    actions: [{ label: t`Open System Settings`, command: 'screen-recording.open-settings' }],
    transient: true,
  });
}

export function recordingFileName(now = new Date()): string {
  return stampedFileName('screen', 'webm', now);
}

function pickMimeType(): string | undefined {
  const MR = (window as unknown as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
  if (!MR?.isTypeSupported) return undefined;
  return ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MR.isTypeSupported(m));
}

async function uploadRecording(file: File): Promise<RecordingPlace> {
  const folder = await dataManager.callAction<null, UploadDir>(new ActionInfo('recording-folder', null, null, 'GET'));
  if (!folder?.abs_path || !folder?.compute_node_id) throw new Error('Could not resolve the recordings folder');
  const [absPath] = await uploadFilesToDir(folder, [file]);
  return { absPath, computeNodeId: folder.compute_node_id };
}

async function finish(): Promise<void> {
  const run = active;
  active = null;
  if (!run) return;
  run.stream.getTracks().forEach((track) => track.stop());
  const durationMs = Date.now() - (state.startedAt ?? Date.now());
  const file = new File(run.chunks, recordingFileName(), { type: run.recorder.mimeType || 'video/webm' });
  // The File owns the bytes now; drop the recorder's copy and its hold on this run.
  run.chunks.length = 0;
  run.recorder.ondataavailable = null;
  run.recorder.onstop = null;
  set({ busy: true, startedAt: null });
  try {
    const place = await uploadRecording(file);
    set({ phase: 'ready', busy: false, recording: { ...place, file, objectUrl: URL.createObjectURL(file), durationMs } });
  } catch (error) {
    failToast(t`Could not save the recording`, error);
    set(IDLE);
  }
}

/** Start a recording: the OS picker, then `MediaRecorder` until `stopRecording` or the OS stops the share. */
export async function startRecording(): Promise<void> {
  if (state.phase !== 'idle' || state.busy) return;
  set({ busy: true });
  const status = await electronAPI()?.screenCaptureStatus?.().catch(() => 'granted');
  if (status === 'denied' || status === 'restricted') {
    macDeniedToast();
    set(IDLE);
    return;
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch (error) {
    // NotAllowedError is the person cancelling the picker (the OS refusal was caught above).
    const name = error instanceof Error ? error.name : '';
    if (name !== 'NotAllowedError' && name !== 'AbortError') failToast(t`Screen recording is not allowed`, error);
    set(IDLE);
    return;
  }
  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const run = { recorder, stream, chunks: [] as Blob[] };
  active = run;
  recorder.ondataavailable = (ev: BlobEvent) => {
    if (ev.data && ev.data.size > 0) run.chunks.push(ev.data);
  };
  recorder.onstop = () => {
    void finish();
  };
  // The OS "Stop sharing" bar ends the track; that is a stop too.
  stream.getVideoTracks()[0]?.addEventListener('ended', () => stopRecording());
  recorder.start();
  set({ phase: 'recording', busy: false, startedAt: Date.now() });
}

export function stopRecording(): void {
  if (active && active.recorder.state !== 'inactive') active.recorder.stop();
}

/** Close the dialog; the file stays where it is (the temp folder, or the project after Save). */
export function dismissRecording(): void {
  if (state.recording) URL.revokeObjectURL(state.recording.objectUrl);
  set(IDLE);
}

/** Save to project moved the file: the dialog's Share must now address the new place. */
export function setRecordingPlace(place: RecordingPlace): void {
  if (state.recording) set({ recording: { ...state.recording, ...place } });
}

export function getRecorderState(): RecorderState {
  return state;
}

/** Test seam: drop the active run and every recording. */
export function resetScreenRecorder(): void {
  active?.stream.getTracks().forEach((track) => track.stop());
  active = null;
  dismissRecording();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useScreenRecorder(): RecorderState {
  return useSyncExternalStore(subscribe, getRecorderState, getRecorderState);
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
