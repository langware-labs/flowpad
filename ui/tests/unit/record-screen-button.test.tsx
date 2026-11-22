/**
 * The recording's presence on the bar, and its dialog. Starting lives in the bar's menu
 * (`top-bar-more-menu.test.tsx`); here: nothing on the bar while idle, a red stop button with
 * the time while recording, and the dialog — mounted from the bar, not the menu — whose Share
 * opens the standard share dialog on the file where it sits, and whose Save moves it through
 * the backend then leaves only Share.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rec = vi.hoisted(() => ({
  state: { phase: 'idle', busy: false, startedAt: null as number | null, recording: null as unknown },
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  dismissRecording: vi.fn(),
  setRecordingPlace: vi.fn(),
}));
vi.mock('@src/components/top-nav-bar/use-screen-recorder', () => ({
  useScreenRecorder: () => rec.state,
  startRecording: rec.startRecording,
  stopRecording: rec.stopRecording,
  dismissRecording: rec.dismissRecording,
  setRecordingPlace: rec.setRecordingPlace,
  formatElapsed: (ms: number) => `00:${String(Math.floor(ms / 1000)).padStart(2, '0')}`,
}));
const sdk = vi.hoisted(() => ({ callAction: vi.fn() }));
vi.mock('@sdk', () => ({
  ActionInfo: class {
    bodyParameters: unknown;
    constructor(public name: string, public type: unknown, public id: unknown, public method: string) {}
  },
  dataManager: { callAction: sdk.callAction },
  TypeId: class {
    constructor(public raw: string) {}
    toString() { return this.raw; }
  },
  VFSPath: { fromMachinePath: (p: string) => ({ rawPath: `compute_node-n1${p}` }) },
}));
const share = vi.hoisted(() => ({ useFileShareSource: vi.fn(), dialog: vi.fn() }));
vi.mock('@src/hooks/use-file-share-source', () => ({ useFileShareSource: share.useFileShareSource }));
vi.mock('@src/components/share-to-conversation/ShareToConversationDialog', () => ({
  ShareToConversationDialog: (props: { source: { label: string } }) => {
    share.dialog(props);
    return <div data-testid="share-dialog">{props.source.label}</div>;
  },
}));
vi.mock('@src/hooks/useContext', () => ({ useContext: () => ({ project: { id: 'p1', name: 'my_first_project' } }) }));
vi.mock('@src/navigation/local-file-pointer', () => ({ dockPointerForFile: (p: string) => ({ toUrl: () => `/dock/file/${p}` }) }));
vi.mock('@src/utils/format-bytes', () => ({ formatBytes: (n: number) => `${n} B` }));
const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('@src/notifications/notify', () => ({ notify: toasts }));
import { RecordingIndicator } from '@src/components/top-nav-bar/RecordScreenButton';
import { RecordingReadyDialog } from '@src/components/top-nav-bar/RecordingReadyDialog';
import { TooltipProvider } from '@src/components/ui/tooltip';

const RECORDING = {
  file: new File(['x'.repeat(2048)], 'screen-2026-11-02-13-26.webm', { type: 'video/webm' }),
  objectUrl: 'blob:preview',
  durationMs: 42_000,
  absPath: '/tmp/flowpad_temp/oss/recordings/screen-2026-11-02-13-26.webm',
  computeNodeId: 'compute_node-n1',
};

function wrap(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe('RecordingIndicator', () => {
  beforeEach(() => {
    rec.state = { phase: 'idle', busy: false, startedAt: null, recording: null };
    share.useFileShareSource.mockReturnValue(null);
    (globalThis.URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => 'blob:preview');
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('idle: nothing on the bar', () => {
    wrap(<RecordingIndicator />);
    expect(screen.queryByTestId('top-nav-recording-stop')).toBeNull();
    expect(screen.queryByTestId('recording-ready-dialog')).toBeNull();
  });

  it('recording: a wide, red, pulsing stop button with the elapsed time; click stops', () => {
    rec.state = { phase: 'recording', busy: false, startedAt: Date.now() - 42_000, recording: null };
    wrap(<RecordingIndicator />);
    const btn = screen.getByTestId('top-nav-recording-stop');
    expect(btn.getAttribute('aria-label')).toBe('Stop recording');
    expect(btn.getAttribute('data-recording')).toBe('true');
    expect(btn.hasAttribute('data-wide')).toBe(true);
    expect(btn.textContent).toContain('00:42');
    expect(btn.className).toContain('text-red-500');
    expect(btn.className).toContain('animate-pulse');
    expect(btn.className).toContain('motion-reduce:animate-none');
    fireEvent.click(btn);
    expect(rec.stopRecording).toHaveBeenCalledTimes(1);
  });

  it('ready: the dialog opens with the file, Share mounts the standard share dialog on it', async () => {
    rec.state = { phase: 'ready', busy: false, startedAt: null, recording: RECORDING };
    share.useFileShareSource.mockImplementation((_node: unknown, path: string | null) => (path ? { label: path.split('/').pop() } : null));
    wrap(<RecordingIndicator />);
    expect(screen.getByTestId('recording-ready-dialog')).toBeTruthy();
    expect(screen.getByTestId('recording-file-name').textContent).toBe('screen-2026-11-02-13-26.webm');
    expect(screen.getByTestId('recording-preview').getAttribute('src')).toBe('blob:preview');
    fireEvent.click(screen.getByTestId('recording-share'));
    await waitFor(() => expect(screen.getByTestId('share-dialog').textContent).toBe('screen-2026-11-02-13-26.webm'));
    expect(share.useFileShareSource.mock.lastCall?.[1]).toBe(RECORDING.absPath);
  });

  it('Save to project moves the file through the backend BY NAME, toasts with Open, and leaves only Share', async () => {
    sdk.callAction.mockResolvedValue({ abs_path: '/proj/recordings/screen-2026-11-02-13-26.webm', compute_node_id: 'compute_node-n1' });
    wrap(<RecordingReadyDialog recording={RECORDING} />);
    fireEvent.click(screen.getByTestId('recording-save-to-project'));
    await waitFor(() => expect(rec.setRecordingPlace).toHaveBeenCalledWith({ absPath: '/proj/recordings/screen-2026-11-02-13-26.webm', computeNodeId: 'compute_node-n1' }));
    const action = sdk.callAction.mock.calls[0][0];
    expect(action.name).toBe('recording-save-to-project');
    expect(action.bodyParameters).toEqual({ name: 'screen-2026-11-02-13-26.webm', project_id: 'p1' });
    expect(toasts.success.mock.calls[0][0]).toMatchObject({
      title: 'Saved to project',
      message: 'my_first_project/recordings/screen-2026-11-02-13-26.webm',
      actions: [{ label: 'Open', href: '/dock/file/compute_node-n1/proj/recordings/screen-2026-11-02-13-26.webm' }],
    });
    await waitFor(() => expect(screen.queryByTestId('recording-save-to-project')).toBeNull());
    expect(screen.getByTestId('recording-share')).toBeTruthy();
    expect(screen.getByTestId('recording-ready-dialog').textContent).toContain('under recordings/');
  });

  it('closing the share dialog ends the flow', async () => {
    share.useFileShareSource.mockImplementation((_node: unknown, path: string | null) => (path ? { label: 'x' } : null));
    wrap(<RecordingReadyDialog recording={RECORDING} />);
    fireEvent.click(screen.getByTestId('recording-share'));
    await waitFor(() => expect(share.dialog).toHaveBeenCalled());
    (share.dialog.mock.lastCall?.[0] as { onClose: () => void }).onClose();
    expect(rec.dismissRecording).toHaveBeenCalled();
  });

  it('closing the dialog keeps the file and clears the recorder', () => {
    wrap(<RecordingReadyDialog recording={RECORDING} />);
    fireEvent.keyDown(screen.getByTestId('recording-ready-dialog'), { key: 'Escape' });
    expect(rec.dismissRecording).toHaveBeenCalled();
    expect(sdk.callAction).not.toHaveBeenCalled();
  });
});
