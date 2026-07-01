import { useCallback, useMemo, useState, type ComponentType } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@src/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@src/components/ui/dropdown-menu';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { DiagnosisReportModal } from '@src/components/version-popover/diagnosis-report-modal';
import { diagnosisToText } from '@src/components/diagnose/diagnosis-details';
import { ForwardDiagnosisShareDialog } from '@src/components/diagnose/forward-diagnosis-share-dialog';
import { OpenInTerminalButton } from '@src/components/diagnose/open-in-terminal-button';
import { deriveConversationTitle } from '@src/components/conversation/conversation-title';
import { useRecentConversations } from '@src/hooks/use-recent-conversations';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';
import { Copy, Eye, Flag, Forward, MessageSquarePlus, Stethoscope, Trash2 } from 'lucide-react';
import {
  systemTools,
  copyToClipboard,
  forwardDiagnosis,
  sendDiagnosisEmailReport,
  FlowpadDiagnosis,
  QueryRequest,
} from '@sdk';

/** Format a record's `created_date` (ISO string or Date) as a local date+time (or em-dash). */
function formatRecorded(value?: string | Date): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

/**
 * An icon button that drops down the most-recent conversations and forwards the
 * diagnosis to the picked one (via `forwardDiagnosis`, which attaches the entity).
 * Used by the Forward action; "Report" emails the team instead and needs no picker.
 */
function ConvPickerButton({
  icon: Icon,
  label,
  onPick,
  diagnosisId,
  diagnosisTitle,
  onForwardedNew,
  disabled,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  onPick: (conversationId: string) => void;
  /** Diagnosis being forwarded — enables the "Start new conversation" item. */
  diagnosisId: string;
  diagnosisTitle?: string;
  /** Called after a successful forward into a *new* conversation. */
  onForwardedNew: (conversationId: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const conversations = useRecentConversations(open);

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            aria-label={label}
            title={label}
            disabled={disabled}
            onClick={(e) => e.stopPropagation()}
          >
            <Icon className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
          {conversations.map((conv) => (
            <DropdownMenuItem key={conv.id} onSelect={() => onPick(conv.id)}>
              <span className="truncate">{deriveConversationTitle(conv)}</span>
            </DropdownMenuItem>
          ))}
          {/* Forward into a brand-new conversation (opens the share dialog with
              a recipient picker), not only an existing one. */}
          <DropdownMenuItem onSelect={() => setShareOpen(true)}>
            <MessageSquarePlus className="mr-2 h-3.5 w-3.5 text-primary" />
            <span className="truncate"><Trans>Start new conversation</Trans></span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ForwardDiagnosisShareDialog
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        diagnosisId={diagnosisId}
        diagnosisTitle={diagnosisTitle}
        onForwarded={onForwardedNew}
      />
    </>
  );
}

/** Per-row action icons: View, Report, Forward, Copy-all, Dismiss (delete). */
function DiagnosisRowActions({
  diag,
  onView,
  onDelete,
  onForwarded,
}: {
  diag: FlowpadDiagnosis;
  onView: () => void;
  onDelete: () => void;
  /** Called after a successful forward — the parent opens the conversation. */
  onForwarded: (conversationId: string) => void;
}) {
  const { t } = useLingui();
  // "Report issue" — email the diagnosis to the Flowpad team (no conversation).
  const handleReport = useCallback(async () => {
    try {
      await sendDiagnosisEmailReport(diag.id);
      notify.success({ title: t`Diagnosis reported to the Flowpad team` });
    } catch (e) {
      notify.error({
        title: t`Could not report diagnosis`,
        message: e instanceof Error ? e.message : t`Report failed.`,
      });
    }
  }, [diag, t]);

  // "Forward" — attach the diagnosis entity into the chosen conversation.
  const handleForward = useCallback(
    async (conversationId: string) => {
      try {
        await forwardDiagnosis(conversationId, diag.id);
        notify.success({ title: t`Diagnosis forwarded` });
        onForwarded(conversationId);
      } catch (e) {
        notify.error({
          title: t`Could not forward diagnosis`,
          message: e instanceof Error ? e.message : t`Send failed.`,
        });
      }
    },
    [diag, onForwarded, t],
  );

  const handleCopy = useCallback(async () => {
    await copyToClipboard(diagnosisToText(diag));
    notify.success({ title: t`Diagnosis copied to clipboard` });
  }, [diag, t]);

  return (
    <div className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" aria-label={t`View diagnosis`} title={t`View`} onClick={onView}>
        <Eye className="h-4 w-4" />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 w-7 p-0"
        aria-label={t`Report issue`}
        title={t`Report issue`}
        onClick={() => void handleReport()}
      >
        <Flag className="h-4 w-4" />
      </Button>
      <ConvPickerButton
        icon={Forward}
        label={t`Forward`}
        onPick={(id) => void handleForward(id)}
        diagnosisId={diag.id}
        diagnosisTitle={diag.title || diag.name || undefined}
        onForwardedNew={onForwarded}
      />
      <OpenInTerminalButton diagnosisId={diag.id} asIcon />
      <Button
        size="sm"
        variant="ghost"
        className="h-7 w-7 p-0"
        aria-label={t`Copy all`}
        title={t`Copy all`}
        onClick={() => void handleCopy()}
      >
        <Copy className="h-4 w-4" />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
        aria-label={t`Delete diagnosis`}
        title={t`Delete`}
        onClick={onDelete}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}

/**
 * Account-settings entry point for the recorded `flowpad_diagnosis` entities.
 * The button opens a dialog with a reactive table of all diagnoses; each row opens
 * the diagnosis viewer popup on click and carries View / Report / Forward /
 * Copy-all / Delete actions. The list is a live entity query, so deletes and newly
 * recorded diagnoses reflect automatically.
 */
export function SystemDiagnoses() {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [viewId, setViewId] = useState<string | null>(null);
  const { navigation } = useDockNavigation();

  // After a forward, close this dialog and open the conversation we sent into.
  const handleForwarded = useCallback(
    (conversationId: string) => {
      setOpen(false);
      navigation.openDock(DockPointer.forConversation(conversationId));
    },
    [navigation],
  );

  // Reactive list of all recorded diagnoses — subscribes to the entity store, so a
  // delete (or a freshly recorded diagnosis) updates the table without a manual
  // refetch. Only queried while the dialog is open.
  const request = useMemo(
    () => new QueryRequest({ type: FlowpadDiagnosis.type, scope: [] }),
    [],
  );
  const { data, isLoading } = useEntitiesQuery<FlowpadDiagnosis>(request, { enabled: open });
  const rows = useMemo(
    () =>
      [...(data ?? [])].sort(
        (a, b) =>
          new Date(b.created_date ?? 0).getTime() - new Date(a.created_date ?? 0).getTime(),
      ),
    [data],
  );
  const loading = isLoading && rows.length === 0;

  // Delete via dataManager (systemTools.deleteDiagnosis) — the store update flows
  // back through the query above, so the row disappears on its own.
  const handleDelete = useCallback(async (id: string) => {
    await systemTools.deleteDiagnosis(id);
  }, []);

  return (
    <>
      <Button variant="outline" className="w-full" onClick={() => setOpen(true)}>
        <Stethoscope className="mr-2 h-4 w-4" />
        <Trans>System Diagnoses</Trans>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle><Trans>System Diagnoses</Trans></DialogTitle>
            <DialogDescription>
              <Trans>Issue diagnoses recorded by the assistant. Click a row to view the full diagnosis.</Trans>
            </DialogDescription>
          </DialogHeader>

          {loading ? (
            <p className="p-4 text-sm text-muted-foreground"><Trans>Loading…</Trans></p>
          ) : rows.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground"><Trans>No diagnoses recorded.</Trans></p>
          ) : (
            <div className="max-h-[60vh] overflow-y-auto rounded-lg border">
              <Table className="table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[28%]"><Trans>Title</Trans></TableHead>
                    <TableHead className="w-[22%]"><Trans>Recorded</Trans></TableHead>
                    <TableHead className="w-[28%]"><Trans>Summary</Trans></TableHead>
                    <TableHead className="w-[22%] text-right"><Trans>Actions</Trans></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((d) => (
                    <TableRow
                      key={d.id}
                      className="cursor-pointer"
                      onClick={() => setViewId(d.id)}
                    >
                      <TableCell className="truncate font-medium" title={d.title || d.name || ''}>
                        {d.title || d.name || '—'}
                      </TableCell>
                      <TableCell className="truncate whitespace-nowrap text-xs text-muted-foreground">
                        {formatRecorded(d.created_date)}
                      </TableCell>
                      <TableCell className="truncate text-xs" title={d.summary || ''}>
                        {d.summary || '—'}
                      </TableCell>
                      <TableCell className="text-right">
                        <DiagnosisRowActions
                          diag={d}
                          onView={() => setViewId(d.id)}
                          onDelete={() => setConfirmId(d.id)}
                          onForwarded={handleForwarded}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <DiagnosisReportModal
        open={viewId !== null}
        diagnosisId={viewId ?? undefined}
        onClose={() => setViewId(null)}
      />

      <ConfirmDialog
        open={confirmId !== null}
        onOpenChange={(next) => {
          if (!next) setConfirmId(null);
        }}
        title={t`Delete diagnosis`}
        description={t`Delete this diagnosis? This cannot be undone.`}
        confirmLabel={t`Delete`}
        variant="destructive"
        onConfirm={() => {
          const target = confirmId;
          setConfirmId(null);
          if (target) void handleDelete(target);
        }}
      />
    </>
  );
}
