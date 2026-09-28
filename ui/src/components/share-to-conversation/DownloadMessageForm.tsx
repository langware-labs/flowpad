/**
 * DownloadMessageForm — write a message, choose what it carries, download it as a `.flowmsg`.
 *
 * The offline half of sharing: no conversation, no recipient, no hub. The file is
 * handed to someone by any means; they upload it from their project home, review
 * what it carries, and install it. One message may carry many entities — the one
 * the share started from plus anything added here.
 */

import { useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Download, Loader2, PackagePlus, X } from 'lucide-react';
import { type AssetDescriptor, exportFlowMessage } from '@sdk';
import { AssetManagerPopover } from '@src/components/asset-manager/AssetManagerPopover';
import { useProcessAssets } from '@src/components/asset-manager/useProcessAssets';
import { displayLabelForDescriptor } from '@src/components/asset-manager/asset-row-helpers';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';

/** Every asset type an offline message can carry — the picker's default set
 *  (skill/subagent/markdown/spec) leaves out agents, MCPs and connectors. */
const PACKABLE_TYPES = ['skill', 'subagent', 'agent', 'mcp', 'markdown', 'spec', 'data_driver', 'credential'] as const;

export interface CarriedEntity {
  /** TypeId string (`skill-<uuid>`). */
  typeid: string;
  label: string;
}

interface DownloadMessageFormProps {
  /** What the message starts out carrying (the shared entity). */
  initial: CarriedEntity[];
  /** Reset the form whenever this flips true (the host dialog's `open`). */
  active: boolean;
  onDone?: () => void;
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function DownloadMessageForm({ initial, active, onDone }: DownloadMessageFormProps) {
  const { t } = useLingui();
  const [text, setText] = useState('');
  const [carried, setCarried] = useState<CarriedEntity[]>(initial);
  const [pickerOpen, setPickerOpen] = useState(false);
  const packable = useProcessAssets(null, { enabled: pickerOpen, types: PACKABLE_TYPES });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const initialKey = initial.map((c) => c.typeid).join(',');
  useEffect(() => {
    if (!active) return;
    setText('');
    setCarried(initial);
    setError(null);
    setBusy(false);
    // `initial` is re-created by callers on every render; its ids are the identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, initialKey]);

  const add = (d: AssetDescriptor) => {
    if (!d.typeid || carried.some((c) => c.typeid === d.typeid)) return;
    setCarried((prev) => [...prev, { typeid: d.typeid, label: displayLabelForDescriptor(d) }]);
  };

  const download = async () => {
    if (busy || carried.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const blob = await exportFlowMessage({ text: text.trim(), asset_references: carried.map((c) => c.typeid) });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      saveBlob(blob, `message-${stamp}.flowmsg`);
      notify.success({ title: t`Message downloaded` });
      onDone?.();
    } catch (err: unknown) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-3 text-sm" data-testid="download-message-form">
      <p className="text-muted-foreground">
        <Trans>
          Download a <code>.flowmsg</code> file. The recipient uploads it on their project home, reviews what it
          carries, and installs it.
        </Trans>
      </p>
      <div className="flex flex-col gap-1.5">
        <label className="text-[11px] uppercase tracking-widest text-muted-foreground">
          <Trans>Message</Trans>
        </label>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t`What should they know?`}
          rows={3}
          disabled={busy}
          data-testid="download-message-text"
          className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="text-[11px] uppercase tracking-widest text-muted-foreground">
          <Trans>Carries</Trans>
        </label>
        <div className="flex flex-wrap items-center gap-1.5" data-testid="download-message-carried">
          {carried.map((c) => (
            <span
              key={c.typeid}
              className="flex max-w-full items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-xs"
              title={c.typeid}
            >
              <span className="truncate">{c.label}</span>
              <button
                type="button"
                onClick={() => setCarried((prev) => prev.filter((p) => p.typeid !== c.typeid))}
                disabled={busy}
                aria-label={t`Remove ${c.label}`}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            disabled={busy}
            data-testid="download-message-add"
            className="flex items-center gap-1 rounded border border-dashed border-border px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <PackagePlus className="h-3 w-3" />
            <Trans>Add…</Trans>
          </button>
          <AssetManagerPopover
            centered
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            onPick={add}
            assets={packable}
            selectedTypeIds={carried.map((c) => c.typeid)}
            searchPlaceholder={t`Search assets…`}
          />
        </div>
      </div>
      <Button
        type="button"
        onClick={() => void download()}
        disabled={busy || carried.length === 0}
        className="w-full gap-2"
        data-testid="download-message-submit"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
        <Trans>Download .flowmsg</Trans>
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

interface DownloadMessageDialogProps {
  open: boolean;
  onClose: () => void;
  initial: CarriedEntity[];
}

/** The form as its own dialog — what the share popup's Download button opens. */
export function DownloadMessageDialog({ open, onClose, initial }: DownloadMessageDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="download-message-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="h-5 w-5 text-primary" />
            <Trans>Download message</Trans>
          </DialogTitle>
        </DialogHeader>
        <DownloadMessageForm initial={initial} active={open} onDone={onClose} />
      </DialogContent>
    </Dialog>
  );
}
