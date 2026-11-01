import { create } from 'zustand';
import type { DiagnosisSpec, HelpRecipient } from '@sdk';
import { t } from '@lingui/core/macro';
import { notify } from '@src/notifications';
import { registerCommand } from '@src/notifications/command-registry';
import { DockPointer } from '@src/navigation/DockPointer';
import {
  sendDiagnosis,
  streamDiagnose,
  type DiagnoseEvent,
  type DiagnoseShare,
  type DiagnoseShared,
} from '@src/components/diagnose/diagnose-stream';

export interface DiagnoseLine {
  kind: 'narration' | 'status' | 'error';
  text: string;
}

export interface DiagnoseDone {
  ok: boolean;
  diagnosisId: string | null;
  conversationId: string | null;
  flowMessageId: string | null;
  diagnosis: DiagnosisSpec | null;
  shared: DiagnoseShared[];
  sharePending: boolean;
}

/** "Eran Shlomo", "Eran Shlomo and the help desk" — who a toast says got it. */
export function recipientsLabel(recipients: HelpRecipient[]): string {
  const names = recipients.map((r) => r.name || r.email || (r.kind === 'desk' ? t`the help desk` : '')).filter(Boolean);
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} ${t`and`} ${names[names.length - 1]}`;
}

interface DiagnoseRunState {
  running: boolean;
  lines: DiagnoseLine[];
  done: DiagnoseDone | null;
  /** Who the results go to and when — the window shows it while running, the toast after. */
  share: DiagnoseShare | null;
  start: (message: string, files: File[], share: DiagnoseShare | null) => void;
  reset: () => void;
}

/** The not-sent toast's "Send to …": actions are serializable, so the send is a named command. */
const SEND_COMMAND = 'diagnose.send';

/** "Diagnosis sent to …" — after the run's own send, and after a "Send to …" click. */
function notifySent(diagnosisId: string, sent: DiagnoseShared[], title: string): void {
  notify.success({
    id: `diagnose:${diagnosisId}`,
    title: t`Diagnosis sent to ${sent.map((s) => s.to).join(', ')}`,
    message: title,
    actions: [{ label: t`Open`, href: DockPointer.forConversation(sent[0].conversation_id).toUrl() }],
    forceToast: true,
  });
}

registerCommand(SEND_COMMAND, (args) => {
  const diagnosisId = String(args.diagnosisId);
  const recipients = JSON.parse(String(args.recipients || '[]')) as HelpRecipient[];
  void sendDiagnosis(diagnosisId, recipients, String(args.conversationId || '') || undefined)
    .then((sent) => {
      if (!sent.length) throw new Error(t`Nothing was sent.`);
      notifySent(diagnosisId, sent, String(args.title || ''));
    })
    .catch((e: unknown) =>
      notify.error({
        title: t`Could not send the diagnosis`,
        message: e instanceof Error ? e.message : String(e),
        forceToast: true,
      }),
    );
});

/** The finish toast — raised here, not by the window, because the window is usually closed by then. */
function announce(done: DiagnoseDone, share: DiagnoseShare | null): void {
  if (!done.ok && !done.diagnosisId) return; // nothing recorded; the window (if open) says why
  const title = done.diagnosis?.title || done.diagnosis?.summary || '';
  if (done.shared.length && done.diagnosisId) {
    notifySent(done.diagnosisId, done.shared, title);
    return;
  }
  const recipients = share?.share_with ?? [];
  if (done.sharePending && done.diagnosisId && recipients.length) {
    const diagnosisId = done.diagnosisId;
    const to = recipientsLabel(recipients);
    notify.info({
      id: `diagnose:${diagnosisId}`,
      title: t`Diagnosis recorded — not sent`,
      message: title,
      actions: [
        {
          label: t`Send to ${to}`,
          command: SEND_COMMAND,
          args: {
            diagnosisId,
            conversationId: share?.conversation_id ?? '',
            recipients: JSON.stringify(recipients),
            title,
          },
        },
      ],
      forceToast: true,
    });
  }
}

/**
 * The one running diagnosis. Lives outside the Diagnose window: closing the window never stops
 * the run, its stream, or the toast that says what happened when it ends.
 */
export const useDiagnoseRunStore = create<DiagnoseRunState>((set, get) => ({
  running: false,
  lines: [],
  done: null,
  share: null,
  start: (message, files, share) => {
    if (get().running) return;
    set({ running: true, lines: [], done: null, share });
    const push = (line: DiagnoseLine) => set((s) => ({ lines: [...s.lines, line] }));
    const onEvent = (ev: DiagnoseEvent) => {
      if (ev.type === 'narration') push({ kind: 'narration', text: ev.text });
      else if (ev.type === 'status') push({ kind: 'status', text: ev.text.trim() });
      else if (ev.type === 'error') push({ kind: 'error', text: ev.text.trim() });
      else if (ev.type === 'done') {
        const done: DiagnoseDone = {
          ok: ev.ok,
          diagnosisId: ev.diagnosis_id,
          conversationId: ev.conversation_id,
          flowMessageId: ev.flow_message_id,
          diagnosis: ev.diagnosis ?? null,
          shared: ev.shared ?? [],
          sharePending: !!ev.share_pending,
        };
        set({ done });
        announce(done, share);
      }
    };
    void streamDiagnose(message, onEvent, undefined, files, share)
      .catch((e: unknown) =>
        push({ kind: 'error', text: t`Diagnose failed: ${e instanceof Error ? e.message : String(e)}` }),
      )
      .finally(() => set({ running: false }));
  },
  reset: () => {
    if (!get().running) set({ lines: [], done: null, share: null });
  },
}));
