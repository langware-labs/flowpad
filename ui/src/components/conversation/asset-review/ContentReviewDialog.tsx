import { useEffect, useState } from 'react';
import { t } from '@lingui/core/macro';
import { Braces, FileText, HardDrive, MinusCircle, PlusCircle, Share2 } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { CopyButton } from '@src/components/ui/copy-button';
import { ReviewShell, ReviewSource } from './ReviewShell';

/** One thing about to be sent: a file name and its text. */
export interface ContentItem {
  name: string;
  content: string;
}

/** What each context file is, in the person's words. */
function describe(name: string): { typeWord: string; description: string } {
  switch (name) {
    case 'diagnosis.value.json':
      return { typeWord: t`Diagnosis`, description: t`What the check found on this computer: status, findings, versions.` };
    case 'screen.value.json':
      return { typeWord: t`Screen`, description: t`The screen you were on when you asked.` };
    case 'session.value.json':
      return { typeWord: t`Session`, description: t`The session on screen and its last messages, secrets masked.` };
    case 'logs.txt':
      return { typeWord: t`Logs`, description: t`The last lines of this computer's logs, secrets masked.` };
    default:
      return { typeWord: t`File`, description: '' };
  }
}

function pretty(item: ContentItem): string {
  if (!item.name.endsWith('.json')) return item.content;
  try {
    return JSON.stringify(JSON.parse(item.content), null, 2);
  } catch {
    return item.content;
  }
}

interface ContentReviewDialogProps {
  open: boolean;
  onClose: () => void;
  items: ContentItem[];
  /** Names the person left out. */
  leftOut: string[];
  onLeftOutChange: (names: string[]) => void;
  /** "Share": the review is done (the caller sends, or keeps going). */
  onShare: () => void;
  shareLabel?: string;
}

/**
 * The message review before SENDING -- the same frame (``ReviewShell``) the receiver reviews a message's
 * attachments in, so what the person checks is what the helper will see. Share / Leave out replace Install.
 */
export function ContentReviewDialog({
  open,
  onClose,
  items,
  leftOut,
  onLeftOutChange,
  onShare,
  shareLabel,
}: ContentReviewDialogProps) {
  const [selectedName, setSelectedName] = useState(items[0]?.name ?? '');
  useEffect(() => {
    if (!items.some((i) => i.name === selectedName)) setSelectedName(items[0]?.name ?? '');
  }, [items, selectedName]);
  const selected = items.find((i) => i.name === selectedName) ?? items[0];
  if (!selected) return null;
  const out = leftOut.includes(selected.name);
  const meta = describe(selected.name);
  const toggle = () =>
    onLeftOutChange(out ? leftOut.filter((n) => n !== selected.name) : [...leftOut, selected.name]);
  const iconOf = (name: string) => (name.endsWith('.json') ? Braces : FileText);

  return (
    <ReviewShell
      open={open}
      onClose={onClose}
      title={t`Context to share — review before sending.`}
      description={t`Review what goes with your request. Leave out anything you don't want to share.`}
      testId="content-review-dialog"
      rows={items.map((i) => ({
        id: i.name,
        name: i.name,
        Icon: iconOf(i.name),
        marked: leftOut.includes(i.name) ? t`Left out` : null,
        testId: `content-review-row-${i.name}`,
      }))}
      selectedId={selected.name}
      onSelect={setSelectedName}
      selected={{
        Icon: iconOf(selected.name),
        name: selected.name,
        typeWord: meta.typeWord,
        description: meta.description,
        source: (
          <ReviewSource
            Icon={HardDrive}
            label={out ? t`Left out — stays on this computer` : t`Captured on this computer — not sent yet`}
          />
        ),
      }}
      actions={
        <>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              onShare();
              onClose();
            }}
            data-testid="content-review-share"
          >
            <Share2 className="h-3.5 w-3.5" />
            {shareLabel ?? t`Share`}
          </Button>
          <Button size="sm" variant="secondary" onClick={toggle} data-testid="content-review-leave-out">
            {out ? <PlusCircle className="h-3.5 w-3.5" /> : <MinusCircle className="h-3.5 w-3.5" />}
            {out ? t`Put back` : t`Leave out`}
          </Button>
        </>
      }
    >
      <div className="rounded-md border border-border" data-testid="staged-review">
        <div className="flex items-center justify-end border-b border-border px-2 py-1">
          <CopyButton value={selected.content} label={t`Copy`} testId="content-review-copy" />
        </div>
        <pre
          className={`max-h-[50vh] overflow-auto whitespace-pre-wrap p-3 font-mono text-xs ${out ? 'opacity-50' : ''}`}
          data-testid="content-review-body"
        >
          {pretty(selected)}
        </pre>
      </div>
    </ReviewShell>
  );
}
